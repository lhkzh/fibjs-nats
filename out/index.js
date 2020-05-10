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
class Index extends events.EventEmitter {
    constructor() {
        super();
        this.subscriptions = {};
        this.address_list = [];
        this.default_server = { host: "127.0.0.1", port: 4222 };
        this.requestTimeout = 10000;
        this.pingBacks = [];
    }
    getInfo() {
        return this.info;
    }
    toAddr(addr) {
        var info = URL.parse(addr);
        var itf = { host: info.hostname, port: info.port.length > 0 ? parseInt(info.port) : 4222 };
        if (info.username.length > 0) {
            itf.user = info.username;
            itf.pass = info.password;
        }
        return itf;
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
        var target = JSON.stringify(itf);
        this.address_list = this.address_list.filter(e => {
            return JSON.stringify(e) != target;
        });
        return true;
    }
    /**
     * 配置连接地址
     * @param addr  ["nats://127.0.0.1:4222", "nats://zhh:pwd@127.0.0.1:4223"]
     */
    server(addr) {
        // this.address_list= util.isArray(addr)?<Array<NatsAddress>>addr:[<NatsAddress>addr];
        this.address_list = [];
        var arr = util.isArray(addr) ? addr : [String(addr)];
        arr.forEach(e => {
            this.address_list.push(this.toAddr(e));
        });
        return this;
    }
    //重连
    reconnect() {
        if (this.re_connet_ing)
            return;
        try {
            this.re_connet_ing = true;
            this.connect(8181, 50, this.autoReconnect);
        }
        finally {
            this.re_connet_ing = false;
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
            this.info = null;
        }
        this.autoReconnect = autoReconnect;
        var tmps = this.address_list && this.address_list.length > 0 ? this.address_list.slice(0) : [this.default_server];
        tmps = shuffle(tmps);
        M: for (var i = 0; i < Math.max(1, retryNum); i++) {
            for (var j = 0; j < tmps.length; j++) {
                var node = tmps[j];
                try {
                    var sock = new net.Socket();
                    sock.connect(node.host, node.port);
                    var stream = new io.BufferedStream(sock);
                    stream.EOL = "\r\n";
                    var info = stream.readLine(360);
                    if (info == null) {
                        continue;
                    }
                    var conn;
                    if (node.user && node.pass) {
                        conn = `CONNECT {"user":"${node.user}","pass":"${node.pass}","verbose":false,"pedantic":false,"ssl_required":false,"name":"","lang":"fibjs","version":"1.0.0"}\r\n`;
                    }
                    else {
                        conn = `CONNECT {"verbose":false,"pedantic":false,"ssl_required":false,"name":"","lang":"fibjs","version":"1.0.0"}\r\n`;
                    }
                    sock.send(Buffer.from(conn));
                    sock.send(B_PING_EOL);
                    var rsp = stream.readLine(8);
                    if (rsp != null) {
                        this.sock = sock;
                        this.stream = stream;
                        this.info = JSON.parse(info.toString().split(" ")[1]);
                        break M;
                    }
                }
                catch (e) {
                }
            }
            if (retryDelay > 0) {
                coroutine.sleep(retryDelay);
            }
        }
        if (this.sock == null) {
            this.emit("error", "connect_nats_fail", JSON.stringify(this.address_list));
            var err = new Error("connect_nats_fail");
            console.log("nats|connect", err.message);
            throw err;
        }
        coroutine.start(this.read2pass.bind(this));
    }
    ping() {
        // return new Promise<boolean>(resolve=>{
        //     if(!this.sock){
        //         resolve(false);
        //     }else{
        //         try{
        //             this.send(B_PING_EOL);
        //             this.pingBacks.push(resolve);
        //         }catch (e) {
        //             resolve(false);
        //         }
        //     }
        // });
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
        this.send(Buffer.from('SUB ' + subject + ' ' + sid + '\r\n'));
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
        var last = this.autoReconnect;
        if (this.sock) {
            this.sock.close();
        }
        coroutine.sleep(10);
        this.autoReconnect = last;
    }
    //发布数据
    publish(subject, payload, inbox) {
        var arr = [B_PUB, Buffer.from(subject)];
        if (inbox) {
            arr.push(B_SPACE, Buffer.from(inbox));
        }
        if (payload != null) {
            var pb = this.encode(payload);
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
    read2pass() {
        var sock = this.sock;
        var stream = this.stream;
        var processMsg = this.process.bind(this);
        var processPong = this.process_pong.bind(this);
        var subVals = Object.values(this.subscriptions);
        if (subVals.length > 0) {
            try {
                subVals.forEach(e => {
                    this.send(Buffer.from('SUB ' + e.subject + ' ' + e.sid + '\r\n'));
                });
            }
            catch (e) {
            }
        }
        while (sock == this.sock) {
            try {
                var line = stream.readLine();
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
                var arr = line.split(" ");
                var subject = arr[1];
                var sid = arr[2];
                var inbox = arr.length > 4 ? arr[3] : null;
                var len = arr.length > 4 ? Number(arr[4]) : Number(arr[3]);
                // console.log(line, len);
                if (len == 0) {
                    coroutine.start(processMsg, subject, sid, EMPTY_BUF, inbox);
                    continue;
                }
                var data = stream.read(len);
                // console.log(data, String(data))
                if (this.is_read_fail(data)) {
                    // console.log("read_fail:1",line,data);
                    break;
                }
                stream.read(2);
                coroutine.start(processMsg, subject, sid, data, inbox);
            }
            catch (e) {
                console.error("nats|read2pass", e);
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
        console.error("nats|on_lost => %s", JSON.stringify(this.info));
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
exports.Index = Index;
class NatsJson extends Index {
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
class NatsMsgpack extends Index {
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
