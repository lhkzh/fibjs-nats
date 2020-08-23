"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/// <reference types="@fibjs/types" />
/**
 * nats客户端实现
 * 协议参考
 * https://www.cnblogs.com/liang1101/p/6641348.html
 * https://github.com/repejota/phpnats
 */
// const OPTIONS={"verbose":false,"pedantic":false,"ssl_required":false,"name":"","lang":"fibjs","version":"1.0.0"};
const util = require("util");
const events = require("events");
const net = require("net");
const io = require("io");
const coroutine = require("coroutine");
const URL = require("url");
const nuid = require("./Nuid");
class Nats extends events.EventEmitter {
    constructor() {
        super();
        this.subscriptions = {};
        this.address_list = [];
        this.default_server = { host: "127.0.0.1", port: 4222 };
        this.requestTimeout = 10000;
        this.pingBacks = [];
        //name=客户端连接名字, noEcho=是否关闭连接自己发出去的消息-回显订阅
        this.connectOption = {};
    }
    getInfo() {
        return this.serverInfo;
    }
    toAddr(addr) {
        if (!util.isString(addr)) {
            return addr;
        }
        var info = URL.parse(String(addr));
        var itf = { host: info.hostname, port: info.port.length > 0 ? parseInt(info.port) : 4222 };
        if (info.username.length > 0) {
            if (info.password == null || info.password.length < 1) {
                itf.auth_token = info.auth;
            }
            else {
                itf.user = info.username;
                itf.pass = info.password;
            }
        }
        return itf;
    }
    static make(cfg) {
        let imp;
        if (cfg) {
            if (cfg.json) {
                imp = new NatsJson();
            }
            else if (cfg.msgpack) {
                imp = new NatsMsgpack();
            }
            else {
                imp = new Nats();
            }
            if (cfg.url) {
                imp.addServer(cfg.url);
            }
            if (cfg.urls) {
                cfg.urls.forEach(u => {
                    imp.addServer(u);
                });
            }
            if (cfg.name) {
                imp.connectOption.name = cfg.name;
            }
            if (cfg.noEcho) {
                imp.connectOption.noEcho = cfg.noEcho;
            }
        }
        else {
            imp = new Nats();
        }
        return imp.connect(2);
    }
    /**
     * 配置连接地址
     * @param addr  ["nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"]
     */
    setServer(addr) {
        // this.address_list= util.isArray(addr)?<Array<NatsAddress>>addr:[<NatsAddress>addr];
        this.address_list = [];
        var arr = util.isArray(addr) ? addr : [String(addr)];
        arr.forEach(e => {
            this.address_list.push(this.toAddr(e));
        });
        return this;
    }
    addServer(addr) {
        var itf = this.toAddr(addr);
        var target = JSON.stringify(itf);
        var had = this.address_list.some(e => {
            return JSON.stringify(e) == target;
        });
        if (had) {
            return;
        }
        this.address_list.push(itf);
        return this;
    }
    removeServer(addr) {
        var itf = this.toAddr(addr);
        this.address_list = this.address_list.filter(e => {
            return e.host == itf.host && e.port == itf.port;
        });
        if (this.serverInfo && this.serverInfo.host == itf.host && this.serverInfo.port == itf.port) {
            this.close();
            this.reconnect();
        }
        return true;
    }
    //重连
    reconnect() {
        let evt = this.re_connet_ing;
        if (evt) {
            let fail_err = new Error();
            evt.wait();
            if (evt["_err_"]) {
                fail_err.message = evt["_err_"].message;
                throw fail_err;
            }
            return;
        }
        try {
            evt = this.re_connet_ing = new coroutine.Event();
            this.connect(8181, 50, this.autoReconnect);
            this.re_connet_ing = null;
            evt.set();
        }
        catch (e) {
            this.re_connet_ing["_err_"] = e;
            this.re_connet_ing = null;
            evt.set();
            throw e;
        }
    }
    /**
     * 建立连接
     * @param retryNum
     * @param retryDelay
     * @param autoReconnect
     */
    connect(retryNum = 3, retryDelay = 60, autoReconnect = true) {
        var last = this.sock;
        if (last != null) {
            try {
                last.close();
            }
            catch (e) {
            }
            this.sock = null;
            this.stream = null;
            this.serverInfo = null;
        }
        this.autoReconnect = autoReconnect;
        let tmps = this.address_list && this.address_list.length > 0 ? this.address_list.slice(0) : [this.default_server];
        tmps = shuffle(tmps);
        M: for (let i = 0; i < Math.max(1, retryNum * tmps.length); i++) {
            for (let j = 0; j < tmps.length; j++) {
                let node = tmps[j], fail_at = "open_sock";
                let sock = new net.Socket();
                try {
                    sock.connect(node.host, node.port);
                    let stream = new io.BufferedStream(sock);
                    stream.EOL = "\r\n";
                    let info = stream.readLine(360);
                    if (info == null) {
                        continue;
                    }
                    let opt = {
                        verbose: false,
                        pedantic: false,
                        ssl_required: false,
                        name: this.connectOption.name || "fibjs-nats",
                        lang: "fibjs",
                        version: "1.0.0"
                    };
                    if (this.connectOption.noEcho) {
                        opt.echo = false;
                    }
                    if (node.user && node.pass) {
                        opt.user = node.user;
                        opt.pass = node.pass;
                    }
                    else if (node.auth_token) {
                        opt.auth_token = node.auth_token;
                    }
                    fail_at = "auth_connect";
                    sock.send(Buffer.from(`CONNECT ${JSON.stringify(opt)}\r\n`));
                    sock.send(B_PING_EOL);
                    if (stream.readLine(8) != null) {
                        this.sock = sock;
                        this.stream = stream;
                        this.serverInfo = JSON.parse(info.toString().split(" ")[1]);
                        break M;
                    }
                    else {
                        sock.close();
                    }
                }
                catch (e) {
                    sock.close();
                    console.error('Nats|open_fail', node.host + ':' + node.port, fail_at);
                }
            }
            if (retryDelay > 0) {
                coroutine.sleep(retryDelay);
            }
        }
        if (this.sock == null) {
            this.emit("error", "connect_nats_fail", JSON.stringify(this.address_list));
            let err = new Error("connect_nats_fail");
            console.log("nats|connect", err.message);
            throw err;
        }
        this.reader = coroutine.start(this.read2parse.bind(this));
        coroutine.sleep(1);
        return this;
    }
    ping() {
        if (!this.sock) {
            return false;
        }
        try {
            this.send(B_PING_EOL);
            var evt = new coroutine.Event(false);
            var ret;
            this.pingBacks.push(suc => {
                ret = suc;
                evt.set();
            });
            evt.wait();
            return ret;
        }
        catch (e) {
            return false;
        }
    }
    /**
     * 请求接口
     * @param subject
     * @param payload
     */
    request(subject, payload) {
        var self = this, sid, subs = self.subscriptions, timeout;
        return new Promise((resolve, reject) => {
            try {
                var inbox = '_INBOX.' + nuid.next();
                sid = self.subscribe(inbox, d => {
                    resolve(d);
                }, 1);
                var part = subs[sid];
                timeout = part.t = setTimeout(() => {
                    delete subs[sid];
                    reject(new Error("nats_req_timeout:" + subject));
                    self.unsubscribe(inbox);
                }, self.requestTimeout);
                self.publish(subject, payload, inbox);
            }
            catch (e) {
                if (sid) {
                    delete subs[sid];
                    if (timeout) {
                        clearTimeout(timeout);
                    }
                }
                reject(e);
            }
        });
    }
    /**
     * 同步-请求接口
     * @param subject
     * @param payload
     */
    requestSync(subject, payload) {
        var sid, subs = this.subscriptions, rsp, inbox = '_INBOX.' + nuid.next(), isTimeouted, timeout, evt = new coroutine.Event(false);
        try {
            sid = this.subscribe(inbox, function (d) {
                rsp = d;
                evt.set();
            }, 1);
            timeout = subs[sid].t = setTimeout(function () {
                isTimeouted = true;
                evt.set();
            }, this.requestTimeout);
            this.publish(subject, payload, inbox);
        }
        catch (e) {
            if (sid) {
                delete subs[sid];
                if (timeout) {
                    clearTimeout(timeout);
                    try {
                        this.unsubscribe(inbox);
                    }
                    catch (e) {
                    }
                }
            }
            throw e;
        }
        evt.wait();
        delete subs[sid];
        clearTimeout(timeout);
        if (isTimeouted) {
            throw new Error("nats_req_timeout_" + subject);
        }
        return rsp;
    }
    /**
     * 抢占式(queue)侦听
     * @param subject
     * @param queue
     * @param callBack
     * @param limit
     */
    queueSubscribe(subject, queue, callBack, limit) {
        return this.subscribe(subject + ' ' + queue, callBack, limit);
    }
    /**
     * 订阅
     * @param subject
     * @param callBack
     * @param limit
     */
    subscribe(subject, callBack, limit) {
        var sid = nuid.next();
        this.subscriptions[sid] = {
            subject: subject,
            sid: sid,
            fn: callBack,
            num: limit > 0 ? limit : -1
        };
        this.send(Buffer.from(`SUB ${subject} ${sid}\r\n`));
        return sid;
    }
    /**
     * 取消订阅
     */
    unsubscribe(sid, quantity) {
        var msg = 'UNSUB ' + sid + (arguments.length > 1 ? ' ' + quantity : '') + '\r\n';
        if (arguments.length < 2) {
            delete this.subscriptions[sid];
        }
        this.send(Buffer.from(msg));
    }
    //取消所有主题-订阅
    unsubscribeSubject(subject) {
        Object.values(this.subscriptions).forEach(e => {
            if (e.subject == subject) {
                this.unsubscribe(e.sid);
            }
        });
    }
    //取消所有订阅
    unsubscribeAll() {
        var vals = Object.values(this.subscriptions);
        this.subscriptions = {};
        if (!this.sock) {
            return;
        }
        vals.forEach(e => {
            try {
                this.unsubscribe(e.sid);
            }
            catch (e) {
            }
        });
    }
    close() {
        this.autoReconnect = false;
        if (this.sock) {
            this.sock.close();
        }
        if (this.reader) {
            this.reader.join();
        }
        else {
            coroutine.sleep(16);
        }
    }
    //发布数据
    publish(subject, payload, inbox) {
        let arr = [B_PUB, Buffer.from(subject)];
        if (inbox) {
            arr.push(B_SPACE, Buffer.from(inbox));
        }
        if (payload != null) {
            let pb = this.encode(payload);
            arr.push(Buffer.from(" " + pb.length + "\r\n"), pb, B_EOL);
        }
        else {
            arr.push(B_PUBLISH_EMPTY);
        }
        this.send(Buffer.concat(arr));
    }
    send(payload) {
        try {
            this.sock.send(payload);
        }
        catch (e) {
            this.on_lost();
            if (this.autoReconnect) {
                if (!this.sock)
                    this.reconnect();
                this.sock.send(payload);
            }
            else {
                throw e;
            }
        }
    }
    process(subject, sid, payload, inbox) {
        var sop = this.subscriptions[sid];
        try {
            var data = payload.length > 0 ? this.decode(payload) : null;
            if (sop) {
                var meta = { subject: subject, sid: sid };
                if (inbox) {
                    meta.reply = (replyData) => {
                        this.publish(inbox, replyData);
                    };
                }
                if (sop.num > 1) {
                    sop.num--;
                    if (sop.num == 0) {
                        delete this.subscriptions[sid];
                        if (sop.t) {
                            clearTimeout(sop.t);
                        }
                    }
                }
                sop.fn(data, meta);
            }
            this.emit(subject, data);
        }
        catch (e) {
            console.error("nats|process", e);
        }
    }
    read2parse() {
        let sock = this.sock;
        let stream = this.stream;
        let processMsg = this.process.bind(this);
        let processPong = this.process_pong.bind(this);
        let subVals = Object.values(this.subscriptions);
        if (subVals.length > 0) {
            try {
                subVals.forEach(e => {
                    this.send(Buffer.from(`SUB ${e.subject} ${e.sid}\r\n`));
                });
            }
            catch (e) {
            }
        }
        while (sock == this.sock) {
            try {
                let line = stream.readLine();
                if (this.is_read_fail(line)) {
                    // console.log("read_fail:0",line,data);
                    break;
                }
                if (line == S_PING) {
                    this.send(B_PONG_EOL);
                    continue;
                }
                else if (line == S_PONG) {
                    coroutine.start(processPong, true);
                    continue;
                }
                else if (line == S_OK) {
                    continue;
                }
                //MSG subject sid size
                let arr = line.split(" ");
                let subject = arr[1];
                let sid = arr[2];
                let inbox = arr.length > 4 ? arr[3] : null;
                let len = arr.length > 4 ? Number(arr[4]) : Number(arr[3]);
                // console.log(line, len);
                if (len == 0) {
                    coroutine.start(processMsg, subject, sid, EMPTY_BUF, inbox);
                    continue;
                }
                let data = stream.read(len);
                // console.log(data, String(data))
                if (this.is_read_fail(data)) {
                    // console.log("read_fail:1",line,data);
                    break;
                }
                stream.read(2);
                coroutine.start(processMsg, subject, sid, data, inbox);
            }
            catch (e) {
                console.error("nats|read2parse", e);
                break;
            }
        }
        sock.close();
    }
    is_read_fail(d) {
        if (d == null) {
            this.on_lost();
            return true;
        }
        return false;
    }
    on_lost() {
        if (this.sock != null) {
            try {
                this.sock.close();
            }
            catch (e) {
            }
        }
        this.sock = null;
        console.error("nats|on_lost => %s", JSON.stringify(this.serverInfo));
        this.emit("lost");
        if (this.autoReconnect) {
            coroutine.start(this.reconnect.bind(this));
        }
        this.process_pong(false);
    }
    process_pong(ret) {
        if (this.pingBacks.length > 0) {
            var a = this.pingBacks.concat();
            this.pingBacks.length = 0;
            try {
                a.forEach(f => {
                    f(ret);
                });
            }
            catch (e) {
                console.error("nats|process_pong", e);
            }
        }
    }
    encode(payload) {
        if (util.isBuffer(payload)) {
            return payload;
        }
        return Buffer.from(String(payload));
    }
    decode(data) {
        return data;
    }
}
exports.Nats = Nats;
class NatsJson extends Nats {
    encode(payload) {
        var pb;
        if (util.isBuffer(payload)) {
            pb = payload;
            pb.writeUInt8(0);
        }
        else {
            pb = Buffer.from(JSON.stringify(payload));
        }
        return pb;
    }
    decode(data) {
        if (data.readUInt8(data.length - 1) == 0) {
            return data.slice(0, data.length - 1);
        }
        return JSON.parse(data.toString());
    }
}
exports.NatsJson = NatsJson;
class NatsMsgpack extends Nats {
    encode(payload) {
        return require('msgpack').encode(payload);
    }
    decode(data) {
        try {
            return require('msgpack').decode(data);
        }
        catch (e) {
            console.error("nats|msgpack_decode_err", e.message);
            return data.toString();
        }
    }
}
exports.NatsMsgpack = NatsMsgpack;
const EMPTY_BUF = new Buffer([]);
const B_SPACE = Buffer.from(" ");
const B_EOL = Buffer.from("\r\n");
const B_PUB = Buffer.from("PUB ");
const B_PUBLISH_EMPTY = Buffer.from(" 0\r\n\r\n");
const B_PING = Buffer.from("PING");
const B_PING_EOL = Buffer.from("PING\r\n");
const B_PONG = Buffer.from("PONG");
const B_PONG_EOL = Buffer.from("PONG\r\n");
const B_OK = Buffer.from("+OK");
const B_ERR = Buffer.from("-ERR");
const S_PING = "PING";
const S_PING_EOL = Buffer.from("PING\r\n");
const S_PONG = "PONG";
const S_PONG_EOL = "PONG\r\n";
const S_OK = "+OK";
/**
 * @hidden
 */
function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
