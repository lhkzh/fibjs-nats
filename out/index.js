"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NatsMsgpack = exports.NatsJson = exports.Nats = void 0;
/// <reference types="@fibjs/types" />
const net = require("net");
const io = require("io");
const coroutine = require("coroutine");
const util = require("util");
const url = require("url");
const events = require("events");
const Nuid_1 = require("./Nuid");
const encoding_1 = require("encoding");
/**
 * nats客户端实现。支持的地址实现（"nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"）
 * 协议参考
 * https://www.cnblogs.com/liang1101/p/6641348.html
 * https://github.com/repejota/phpnats
 */
class Nats extends events.EventEmitter {
    constructor() {
        super();
        this.subscriptions = new Map();
        this.address_list = [];
        this.default_server = { host: "127.0.0.1", port: 4222 };
        this.send_lock = new coroutine.Lock();
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
        let info = url.parse(String(addr));
        let itf = { host: info.hostname, port: info.port.length > 0 ? parseInt(info.port) : 4222 };
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
    //构建一个-并主动链接
    static make(cfg, retryConnectNum = 3) {
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
        return imp.connect(retryConnectNum);
    }
    /**
     * 配置连接地址
     * @param addr  ["nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"]
     */
    setServer(addr) {
        // this.address_list= Array.isArray(addr)?<Array<NatsAddress>>addr:[<NatsAddress>addr];
        this.address_list = [];
        (Array.isArray(addr) ? addr : [String(addr)]).forEach(e => {
            this.address_list.push(this.toAddr(e));
        });
        return this;
    }
    //添加服务地址
    addServer(addr) {
        let itf = this.toAddr(addr);
        let target = JSON.stringify(itf);
        let had = this.address_list.some(e => {
            return JSON.stringify(e) == target;
        });
        if (had) {
            return;
        }
        this.address_list.push(itf);
        return this;
    }
    //移除一个节点服务
    removeServer(addr) {
        let itf = this.toAddr(addr);
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
    reconnect(sucBack) {
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
            sucBack && sucBack();
        }
        catch (e) {
            this.re_connet_ing = null;
            evt["_err_"] = e;
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
        let last = this.sock;
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
                let node = tmps[j], fail_at = "open_sock", sock = new net.Socket(net.AF_INET), stream;
                try {
                    sock.connect(node.host, node.port);
                    stream = new io.BufferedStream(sock);
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
        coroutine.start(this.read2pass.bind(this));
        coroutine.sleep();
        return this;
    }
    /**
     * 检测是否能连通
     */
    ping() {
        if (!this.sock) {
            return false;
        }
        try {
            this.send(B_PING_EOL);
            let evt = new coroutine.Event(false), ret;
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
    request(subject, payload, timeoutTtl = 3000) {
        let self = this, sid, subs = self.subscriptions, timeout;
        return new Promise((resolve, reject) => {
            try {
                let inbox = '_INBOX.' + Nuid_1.nuid.next();
                sid = self.subscribe(inbox, d => {
                    resolve(d);
                }, 1);
                let part = subs.get(sid);
                timeout = part.t = setTimeout(() => {
                    subs.delete(sid);
                    reject(new Error("nats_req_timeout:" + subject));
                    self.unsubscribe(inbox);
                }, timeoutTtl);
                self.publish(subject, payload, inbox);
            }
            catch (e) {
                if (sid) {
                    subs.delete(sid);
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
    requestSync(subject, payload, timeoutTtl = 3000) {
        let self = this, subs = this.subscriptions, inbox = '_INBOX.' + Nuid_1.nuid.next(), evt = new coroutine.Event(false), isTimeouted, timeout, sid, rsp;
        try {
            sid = this.subscribe(inbox, function (d) {
                rsp = d;
                evt.set();
            }, 1);
            timeout = subs.get(sid).t = setTimeout(function () {
                isTimeouted = true;
                subs.delete(sid);
                evt.set();
                try {
                    self.unsubscribe(inbox);
                }
                catch (e) {
                }
            }, timeoutTtl);
            this.publish(subject, payload, inbox);
        }
        catch (e) {
            if (sid) {
                subs.delete(sid);
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
        subs.delete(sid);
        clearTimeout(timeout);
        if (isTimeouted) {
            throw new Error("nats_req_timeout_" + subject);
        }
        return rsp;
    }
    /**
     * 抢占式(queue)侦听主题
     * @param subject
     * @param queue
     * @param callBack
     * @param limit
     */
    queueSubscribe(subject, queue, callBack, limit) {
        return this.subscribe(subject + ' ' + queue, callBack, limit);
    }
    /**
     * 订阅主题
     * @param subject 主题
     * @param callBack 回调函数
     * @param limit 限制执行次数，默认无限次
     * @returns 订阅的编号
     */
    subscribe(subject, callBack, limit) {
        let sid = Nuid_1.nuid.next();
        this.subscriptions.set(sid, {
            subject: subject,
            sid: sid,
            fn: callBack,
            num: limit > 0 ? limit : -1
        });
        this.send(Buffer.from(`SUB ${subject} ${sid}\r\n`));
        return sid;
    }
    /**
     * 取消订阅
     * @param sid 订阅编号
     * @param quantity
     */
    unsubscribe(sid, quantity) {
        let msg = arguments.length > 1 ? `UNSUB ${sid} ${quantity}\r\n` : `UNSUB ${sid}\r\n`;
        this.send(Buffer.from(msg));
        if (arguments.length < 2) {
            this.subscriptions.delete(sid);
        }
    }
    /**
     * 取消目标主题的订阅
     * @param subject 主题
     */
    unsubscribeSubject(subject) {
        for (let e of this.subscriptions.values()) {
            if (e.subject == subject) {
                this.unsubscribe(e.sid);
            }
        }
    }
    /**
     * 取消所有订阅
     */
    unsubscribeAll() {
        let vals = this.subscriptions.values();
        this.subscriptions = new Map();
        if (!this.sock) {
            return;
        }
        for (let e of vals) {
            try {
                this.unsubscribe(e.sid);
            }
            catch (e) {
            }
        }
    }
    /**
     * 关闭链接
     */
    close() {
        let last = this.autoReconnect;
        this.autoReconnect = false;
        if (this.sock) {
            this.sock.close();
        }
        coroutine.sleep();
        this.autoReconnect = last;
    }
    /**
     * 发布数据
     * @param subject 主题
     * @param payload 数据
     * @param inbox 队列标记
     */
    publish(subject, payload, inbox) {
        let arr = [B_PUB, Buffer.from(subject)];
        if (inbox) {
            arr.push(B_SPACE, Buffer.from(inbox));
        }
        if (payload != null) {
            let pb = this.encode(payload);
            arr.push(Buffer.from(` ${pb.length}\r\n`), pb, B_EOL);
        }
        else {
            arr.push(B_PUBLISH_EMPTY);
        }
        this.send(Buffer.concat(arr));
    }
    send(payload) {
        try {
            this.send_lock.acquire();
            this.sock.send(payload);
        }
        catch (e) {
            this.on_lost();
            if (this.autoReconnect) {
                if (!this.sock) {
                    this.reconnect(() => {
                        this.send(payload);
                    });
                }
            }
            else {
                throw e;
            }
        }
        finally {
            this.send_lock.release();
        }
    }
    process_msg(subject, sid, payload, inbox) {
        let sop = this.subscriptions.get(sid);
        try {
            let data = payload.length > 0 ? this.decode(payload) : null;
            if (sop) {
                let meta = {
                    subject: subject,
                    sid: sid
                };
                if (inbox) {
                    meta.reply = (replyData) => {
                        this.publish(inbox, replyData);
                    };
                }
                if (sop.num > 1) {
                    sop.num--;
                    if (sop.num == 0) {
                        this.subscriptions.delete(sid);
                        if (sop.t) {
                            clearTimeout(sop.t);
                        }
                    }
                }
                sop.fn(data, meta);
            }
            else if (inbox) { //队列选了当前执行节点，但是当前节点给取消订阅了
                this.publish(subject, payload, inbox);
            }
            this.emit(subject, data);
        }
        catch (e) {
            console.error("nats|process", e);
        }
    }
    read2pass() {
        const sock = this.sock;
        const stream = this.stream;
        const processMsg = this.process_msg.bind(this);
        const processPong = this.process_pong.bind(this);
        try {
            for (let e of this.subscriptions.values()) {
                sock.send(Buffer.from(`SUB ${e.subject} ${e.sid}\r\n`));
            }
        }
        catch (e) {
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
                let len = Number(arr.pop());
                // console.log(line, len);
                let data = EMPTY_BUF;
                if (len > 0) {
                    data = stream.read(len);
                    // console.log(data, String(data))
                    if (this.is_read_fail(data)) {
                        // console.log("read_fail:1",line,data);
                        break;
                    }
                }
                coroutine.start(processMsg, subject, sid, data, inbox);
                stream.read(2);
            }
            catch (e) {
                console.error("nats|read2pass", e);
                break;
            }
        }
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
        if (ret) {
            let cb = this.pingBacks.shift();
            if (cb) {
                try {
                    cb(ret);
                }
                catch (e) {
                    console.error("nats|process_pong", e);
                }
            }
        }
        else {
            let a = this.pingBacks.concat();
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
        if (Buffer.isBuffer(payload)) {
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
        return Buffer.from(JSON.stringify(payload));
    }
    decode(data) {
        return JSON.parse(data.toString());
    }
}
exports.NatsJson = NatsJson;
class NatsMsgpack extends Nats {
    encode(payload) {
        return encoding_1.msgpack.encode(payload);
    }
    decode(data) {
        try {
            return encoding_1.msgpack.decode(data);
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
