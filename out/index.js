"use strict";
/// <reference types="@fibjs/types" />
Object.defineProperty(exports, "__esModule", { value: true });
exports.NatsSerizalize_Buf = exports.NatsSerizalize_Str = exports.NatsSerizalize_Msgpack = exports.NatsSerizalize_Json = exports.NatsEvent = exports.Nats = exports.LANG = exports.VERSION = void 0;
const coroutine = require("coroutine");
const util = require("util");
const events = require("events");
const net = require("net");
const ws = require("ws");
const ssl = require("ssl");
const Nuid_1 = require("./Nuid");
const encoding_1 = require("encoding");
const url_1 = require("url");
const queryString = require("querystring");
const events_1 = require("events");
const io_1 = require("io");
exports.VERSION = "1.1.0";
exports.LANG = "fibjs";
/**
 * nats客户端实现。支持的地址实现（"nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"）
 * 协议参考
 * https://www.cnblogs.com/liang1101/p/6641348.html
 * https://github.com/repejota/phpnats
 */
class Nats extends events.EventEmitter {
    constructor() {
        super();
        this._serverList = [];
        this.subscriptions = new Map();
        this._pingBacks = [];
        this._okWaits = [];
        this._serverList = [];
    }
    getInfo() {
        return this._info;
    }
    /**
     * 配置连接地址
     * @param addr  ["nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"]
     */
    setServer(addr) {
        this._serverList = [];
        if (Array.isArray(addr)) {
            addr.forEach(e => {
                this.addServer(e);
            });
        }
        else {
            this.addServer(addr);
        }
        return this;
    }
    //添加服务地址
    addServer(addr) {
        let natAddr = util.isString(addr) ? convertToAddress(addr) : addr;
        let jsonAddr = JSON.stringify(natAddr);
        let had = this._serverList.some(e => {
            return JSON.stringify(e) == jsonAddr;
        });
        if (had) {
            return;
        }
        this._serverList.push(natAddr);
        return this;
    }
    //移除一个节点服务
    removeServer(addr) {
        let natAddr = util.isString(addr) ? convertToAddress(addr) : addr;
        this._serverList = this._serverList.filter(e => e.url != natAddr.url);
        if (this._connection && this._connection.address.url == natAddr.url) {
            this.close();
            this.reconnect();
        }
        return true;
    }
    //重连
    reconnect() {
        let evt = this._reConnetIng;
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
            evt = this._reConnetIng = new coroutine.Event();
            this.close();
            this._do_connect(true);
            this._reConnetIng = null;
            evt.set();
        }
        catch (e) {
            this._reConnetIng = null;
            evt["_err_"] = e;
            evt.set();
            throw e;
        }
    }
    _do_connect(isReconnect) {
        let tmps = this._shuffle_server_list();
        let retryNum = this._cfg.maxReconnectAttempts > 0 ? this._cfg.maxReconnectAttempts : 1;
        let suc_connection;
        M: for (let i = 0; i < retryNum * tmps.length; i++) {
            for (let j = 0; j < tmps.length; j++) {
                let address = tmps[j];
                try {
                    let connection = address.url.startsWith("ws") ? NatsWebsocket.connect(address, this._cfg) : NatsSocket.connect(address, this._cfg);
                    if (connection) {
                        suc_connection = connection;
                        break M;
                    }
                }
                catch (e) {
                    console.error('Nats|open_fail', address.url, e.message);
                }
                if (this._cfg.reconnectWait > 0) {
                    if (this._cfg.noRandomize) {
                        coroutine.sleep(this._cfg.reconnectWait);
                    }
                    else {
                        coroutine.sleep(this._cfg.reconnectWait + Math.ceil(Math.random() * 50));
                    }
                }
            }
        }
        if (suc_connection == null) {
            this.emit(exports.NatsEvent.OnIoError, "connect_nats_fail", JSON.stringify(this._serverList));
            let err = new Error("connect_nats_fail");
            console.log("nats|connect", err.message);
            throw err;
        }
        else {
            this._on_connect(suc_connection, isReconnect);
            return this;
        }
    }
    _shuffle_server_list() {
        let a = this._serverList.concat();
        if (a.length < 1) {
            a = [{ ...DefaultAddress }];
        }
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }
    /**
     * 建立连接
     * @param retryNum
     * @param retryDelay
     * @param autoReconnect
     */
    connect() {
        if (this._connection) {
            return this;
        }
        this._do_connect(false);
        return this;
    }
    /**
     * 检测是否能连通
     */
    ping() {
        if (!this._connection) {
            return false;
        }
        try {
            this.send(B_PING_EOL);
            let evt = new coroutine.Event(false), ret;
            this._pingBacks.push(suc => {
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
        if (!this._connection) {
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
        let flag = this._cfg.reconnect;
        this._cfg.reconnect = false;
        let last = this._connection;
        if (last) {
            this._connection = null;
            last.close();
        }
        this._cfg.reconnect = flag;
        this._on_pong(true);
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
            this._connection.send(payload);
        }
        catch (e) {
            if (this._cfg.reconnect) {
                this.once(exports.NatsEvent.OnReCnnect, () => {
                    this.send(payload);
                });
            }
            else {
                throw e;
            }
        }
    }
    _on_msg(subject, sid, payload, inbox) {
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
            console.error("nats|on_msg", e);
        }
    }
    _on_connect(connection, isReconnected) {
        this._connection = connection;
        this._at = connection.address;
        connection.on("pong", this._on_pong.bind(this));
        connection.on("msg", this._on_msg.bind(this));
        connection.on("close", this._on_lost.bind(this));
        connection.on("ok", this._on_ok.bind(this));
        for (let e of this.subscriptions.values()) {
            connection.send(Buffer.from(`SUB ${e.subject} ${e.sid}\r\n`));
        }
        coroutine.start(() => {
            if (this._connection == connection) {
                this.emit(exports.NatsEvent.OnCnnect);
                if (isReconnected) {
                    this.emit(exports.NatsEvent.OnReCnnect);
                }
            }
        });
    }
    _on_ok(err) {
        if (err) {
        }
        else {
        }
    }
    _on_lost() {
        let last = this._connection;
        this.close();
        if (last != null) {
            console.error("nats|on_lost => %s", JSON.stringify(this._at));
            this.emit(exports.NatsEvent.OnLost);
            if (this._cfg.reconnect) {
                this.reconnect();
            }
        }
    }
    _on_pong(is_lost) {
        if (is_lost) {
            let a = this._pingBacks;
            this._pingBacks = [];
            try {
                a.forEach(f => {
                    f(false);
                });
            }
            catch (e) {
                console.error("nats|on_pong", e);
            }
        }
        else {
            let cb = this._pingBacks.shift();
            if (cb) {
                try {
                    cb(true);
                }
                catch (e) {
                    console.error("nats|on_pong", e);
                }
            }
        }
    }
    encode(payload) {
        return this._cfg.serizalize.encode(payload);
    }
    decode(data) {
        return this._cfg.serizalize.decode(data);
    }
    //构建一个-并主动链接
    static make(cfg) {
        let imp = new Nats();
        let conf;
        if (typeof (cfg) == "string") {
            imp.addServer(cfg);
        }
        else if (cfg.servers) {
            cfg.servers.forEach(e => {
                imp.addServer(e);
            });
            conf = { ...DefaultConfig, ...cfg };
            delete conf["servers"];
        }
        else if (typeof (cfg.url) != "string" || Object.values(cfg).some(e => typeof (e) != "string")) {
            imp.addServer(cfg.url);
            conf = { ...DefaultConfig, ...cfg };
            delete conf["url"];
        }
        else {
            imp.addServer(cfg);
        }
        imp._cfg = conf || { ...DefaultConfig };
        if (imp._cfg.serizalize == null) {
            if (imp._cfg["json"]) {
                conf.serizalize = exports.NatsSerizalize_Json;
            }
            else if (imp._cfg["msgpack"]) {
                conf.serizalize = exports.NatsSerizalize_Msgpack;
            }
            else {
                imp._cfg.serizalize = exports.NatsSerizalize_Buf;
            }
        }
        return imp._do_connect(false);
    }
}
exports.Nats = Nats;
exports.NatsEvent = Object.freeze({
    OnCnnect: "connect",
    OnIoError: "error",
    OnLost: "lost",
    OnReconnectFail: "on_reconnect_fail",
    OnReCnnect: "reconnect"
});
exports.NatsSerizalize_Json = Object.freeze({ encode: (payload) => Buffer.from(JSON.stringify(payload)), decode: (buf) => {
        try {
            return JSON.parse(buf.toString());
        }
        catch (e) {
            console.error("[" + buf.toString() + "]", e.toString());
            throw e;
        }
    } });
exports.NatsSerizalize_Msgpack = Object.freeze({ encode: (payload) => encoding_1.msgpack.encode(payload), decode: (buf) => encoding_1.msgpack.decode(buf) });
exports.NatsSerizalize_Str = Object.freeze({ encode: (payload) => Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)), decode: (buf) => buf.toString() });
exports.NatsSerizalize_Buf = Object.freeze({ encode: (payload) => Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)), decode: (buf) => buf });
const DefaultAddress = { url: "nats://localhost:4222" };
const DefaultConfig = { timeout: 3000, reconnect: true, reconnectWait: 250, maxReconnectAttempts: 86400, name: "fibjs-nats", noEcho: true };
class NatsConnection extends events_1.EventEmitter {
    constructor(_cfg, _addr, _info) {
        super();
        this._cfg = _cfg;
        this._addr = _addr;
        this._info = _info;
        if (this._cfg.pingInterval > 0 && this._cfg.maxPingOut > 0) {
            this._pingIng = 0;
            this._do_ping();
        }
    }
    _do_ping() {
        if (this._pingIng > this._cfg.maxPingOut) {
            if (this._state == 1) {
                this._on_lost("maxPingOut");
            }
            return;
        }
        this._pingIng++;
        this._pingTimer = setTimeout(this._do_ping.bind(this), this._cfg.pingInterval);
        this.once("pong", () => {
            this._pingIng = 0;
            clearTimeout(this._pingTimer);
        });
        try {
            this.send(B_PING_EOL);
        }
        catch (e) {
            clearTimeout(this._pingTimer);
        }
    }
    get address() {
        return this._addr;
    }
    get info() {
        return this._info;
    }
    fire(evt, ...args) {
        coroutine.start(() => {
            try {
                this.emit(evt, ...args);
            }
            catch (e) {
                console.error("process_nats:" + evt, e);
            }
        });
    }
    _fn_close() {
    }
    _on_lost(reason = "") {
        if (this._state == 1) {
            this._state = 3;
            try {
                this._fn_close();
            }
            catch (e) {
            }
            this.emit("close", { type: "close", code: 888, reason: reason });
        }
    }
    close() {
        this._on_lost("close");
        this.eventNames().forEach(e => {
            this.off(e);
        });
    }
}
class NatsSocket extends NatsConnection {
    constructor(_sock, _stream, _cfg, _addr, _info) {
        super(_cfg, _addr, _info);
        this._sock = _sock;
        this._stream = _stream;
        _sock.timeout = 0;
        this._lock = new coroutine.Lock();
        this._state = 1;
        this._reader = coroutine.start(this._read.bind(this));
    }
    _read() {
        let stream = this._stream;
        let is_fail = (s) => s === null;
        while (this._state == 1) {
            try {
                let line = stream.readLine();
                if (is_fail(line)) {
                    // console.log("read_fail:0",line,data);
                    break;
                }
                if (line == S_PING) {
                    this.send(B_PONG_EOL);
                }
                else if (line == S_PONG) {
                    this.fire("pong");
                }
                else if (line == S_OK) {
                    this.fire("ok");
                }
                else {
                    //MSG subject sid size
                    let arr = line.split(" "), subject = arr[1], sid = arr[2], inbox, len, data = EMPTY_BUF;
                    if (arr.length > 4) {
                        inbox = arr[3];
                        len = Number(arr[4]);
                    }
                    else {
                        len = Number(arr[3]);
                    }
                    // console.log(line, len);
                    if (len > 0) {
                        data = stream.read(len);
                        // console.log(data, String(data))
                        if (is_fail(data)) {
                            // console.log("read_fail:1",line,data);
                            break;
                        }
                    }
                    stream.read(2);
                    this.fire("msg", subject, sid, data, inbox);
                }
            }
            catch (e) {
                console.error("nats|reading", e);
                this._on_lost(e.message);
                break;
            }
        }
        this._on_lost("read_lost");
    }
    send(payload) {
        try {
            this._lock.acquire();
            this._sock.send(payload);
            this._lock.release();
        }
        catch (e) {
            this._lock.release();
            this._on_lost(e.message);
            throw e;
        }
    }
    _fn_close() {
        this._sock.close();
    }
    static connect(addr, cfg) {
        let sock = new net.Socket(net.AF_INET), stream;
        let url_obj = url_1.parse(addr.url);
        let fn_close = () => {
            try {
                sock.close();
            }
            catch (e) {
            }
        };
        try {
            if (cfg.timeout > 0) {
                sock.timeout = cfg.timeout;
            }
            sock.connect(url_obj.hostname, parseInt(url_obj.port) || 4222);
            stream = new io_1.BufferedStream(sock);
            stream.EOL = "\r\n";
            let info = stream.readLine(512);
            if (info == null) {
                fn_close();
                throw new Error("closed_while_reading_info");
            }
            let opt = {
                verbose: false,
                pedantic: false,
                ssl_required: false,
                name: cfg.name,
                lang: exports.LANG,
                version: exports.VERSION,
                noEcho: cfg.noEcho,
            };
            if (addr.user && addr.pass) {
                opt.user = addr.user;
                opt.pass = addr.pass;
            }
            else if (addr.token) {
                opt.auth_token = addr.token;
            }
            sock.send(Buffer.from(`CONNECT ${JSON.stringify(opt)}\r\n`));
            sock.send(B_PING_EOL);
            if (stream.readLine(6) != null) {
                return new NatsSocket(sock, stream, cfg, addr, JSON.parse(info.toString().split(" ")[1]));
            }
            else {
                fn_close();
                throw new Error("auth_connect_fail");
            }
        }
        catch (e) {
            sock.close();
            console.error('Nats|open_fail', addr.url, e.message);
        }
        return null;
    }
}
class NatsWebsocket extends NatsConnection {
    constructor(_sock, _cfg, _addr, _info) {
        super(_cfg, _addr, _info);
        this._sock = _sock;
        this._state = 1;
        _sock.onclose = e => {
            this._on_lost(e.reason);
        };
        _sock.onmessage = e => {
            this.processMsg(e.data);
        };
    }
    processMsg(buf) {
        if (this._last) {
            this._last.append(buf);
            buf = this._last;
            this._last = null;
        }
        let idx, offset = 0;
        while ((idx = buf.indexOf(B_EOL, offset)) > -1) {
            if (idx == 0) {
                offset += 2;
                if (buf.length > offset) {
                    continue;
                }
                return;
            }
            // let line = buf.slice(0,idx).toString();
            // buf = buf.slice(idx+2);
            // offset = 0;
            // if (line == S_PING) {
            //     this.send(B_PONG_EOL);
            // } else if (line == S_PONG) {
            //     this.fire("pong");
            // } else if (line == S_OK) {
            //     this.fire("ok");
            // } else {
            let line = buf.slice(0, idx);
            if (B_PING.equals(line)) {
                buf = buf.slice(idx + 2);
                offset = 0;
                this.send(B_PONG_EOL);
            }
            else if (B_PONG.equals(line)) {
                buf = buf.slice(idx + 2);
                offset = 0;
                this.fire("pong");
            }
            else if (B_OK.equals(line)) {
                buf = buf.slice(idx + 2);
                offset = 0;
                this.fire("ok");
            }
            else {
                //MSG subject sid size
                let arr = line.toString().split(" "), subject = arr[1], sid = arr[2], inbox, len, data = EMPTY_BUF;
                if (arr.length > 4) {
                    inbox = arr[3];
                    len = Number(arr[4]);
                }
                else {
                    len = Number(arr[3]);
                }
                if (buf.length < (idx + len + 2)) {
                    break;
                }
                data = buf.slice(idx + 2, idx + 2 + len);
                buf = buf.slice(idx + len + 4);
                offset = 0;
                this.fire("msg", subject, sid, data, inbox);
            }
        }
        if (buf.length > offset) {
            this._last = buf.slice(offset);
        }
    }
    send(payload) {
        try {
            this._sock.send(payload);
        }
        catch (e) {
            this._on_lost(e.message);
            throw e;
        }
    }
    _fn_close() {
        this._sock.close();
    }
    static connect(addr, cfg) {
        if (addr.url.startsWith("wss")) {
            ssl.loadRootCerts();
            // @ts-ignore
            ssl.verification = ssl.VERIFY_NONE;
        }
        let sock = new ws.Socket(addr.url, { perMessageDeflate: false });
        let svr_info;
        let open_evt = new coroutine.Event();
        let err_info = null;
        sock.once("open", e => {
            sock.off("error");
            open_evt.set();
            sock.once("message", e => {
                svr_info = JSON.parse(e.data.toString().replace("INFO ", "").trim());
                open_evt.set();
            });
            sock.once("close", e => {
                err_info = "closed_while_reading_info";
                open_evt.set();
            });
        });
        sock.once("error", e => {
            err_info = e && e.reason ? e.reason : "io_error";
            open_evt.set();
        });
        open_evt.wait();
        if (!err_info) {
            if (!svr_info) {
                open_evt.clear();
                open_evt.wait();
            }
        }
        if (!svr_info) {
            sock.close();
            console.error('Nats|open_fail', addr.url, err_info);
            return null;
        }
        sock.off("error");
        sock.off("message");
        sock.off("close");
        return new NatsWebsocket(sock, cfg, addr, svr_info);
    }
}
function convertToAddress(uri) {
    let obj = url_1.parse(uri);
    let itf = { ...DefaultAddress, url: String(uri) };
    if (obj.query) {
        let query = queryString.parse(obj.query);
        if (query.first("user") && query.first("pass")) {
            itf.user = query.first("user");
            itf.pass = query.first("pass");
        }
        if (query.first("token")) {
            itf.token = query.first("token");
        }
    }
    if (!itf.token && obj.auth && !obj.password) {
        itf.token = obj.auth;
    }
    else if (!itf.user && obj.username && obj.password) {
        itf.user = obj.username;
        itf.pass = obj.password;
    }
    let auth_str = "";
    if (itf.token) {
        auth_str = itf.token + "@";
    }
    else if (itf.user) {
        auth_str = itf.user + ":" + itf.pass + "@";
    }
    itf.url = obj.protocol + "//" + auth_str + obj.hostname + ":" + (parseInt(obj.port) || 4222);
    return itf;
}
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
const B_OK_EOL = Buffer.from("+OK\r\n");
const B_ERR = Buffer.from("-ERR");
const S_PING = "PING";
const S_PING_EOL = Buffer.from("PING\r\n");
const S_PONG = "PONG";
const S_PONG_EOL = "PONG\r\n";
const S_OK = "+OK";
