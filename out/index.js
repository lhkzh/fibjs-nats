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
const crypto = require("crypto");
const Nuid_1 = require("./Nuid");
const encoding_1 = require("encoding");
const url_1 = require("url");
const queryString = require("querystring");
const events_1 = require("events");
const io_1 = require("io");
const http = require("http");
exports.VERSION = "1.1.2";
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
        //订阅的编号id-订阅信息
        this._subs = new Map();
        this._pingBacks = [];
        //执行回调中的数量
        this._bakIngNum = 0;
        this._tops_x = { incr: this._subject_incr.bind(this), decr: this._subject_decr.bind(this) };
        this._subject_incr = this._subject_x;
        this._subject_decr = this._subject_x;
    }
    /**
     * 开启快速检测-(isSubscribeSubject,countSubscribeSubject)
     */
    fastCheck() {
        this._subject_incr = this._tops_x.incr;
        this._subject_decr = this._tops_x.decr;
        this._tops = new Map();
        return this;
    }
    /**
     * 当前链接的服务器地址
     */
    get address() {
        return this._connection ? this._connection.address : null;
    }
    /**
     * 当前链接的服务器的信息
     */
    get info() {
        return this._connection ? this._connection.info : null;
    }
    /**
     * 用于分析当前链接状态
     */
    get stat() {
        return {
            subNum: this._subs.size,
            topicNum: this._tops.size,
            bakNum: this._bakIngNum
        };
    }
    /**
     * 配置连接地址
     * @param addr  ["nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"]
     */
    setAllServer(addr) {
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
            this._close();
            this.reconnect();
        }
        return this;
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
            this._close();
            this._do_connect(-1);
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
    _do_connect(state) {
        let tmps = this._shuffle_server_list();
        let retryNum = state > 0 ? state : (this._cfg.maxReconnectAttempts > 0 ? this._cfg.maxReconnectAttempts : 1);
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
            this.emit(NatsEvent.OnError, "connect_nats_fail", JSON.stringify(this._serverList));
            let err = new Error("connect_nats_fail");
            console.warn("nats|connect", err.message);
            throw err;
        }
        else {
            this._on_connect(suc_connection, state < 0);
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
        this._do_connect(0);
        return this;
    }
    /**
     * 检测是否能连通
     */
    ping() {
        if (!this._connection) {
            return false;
        }
        let cbks = this._pingBacks;
        let evt = new WaitEvt();
        cbks.push(evt);
        try {
            this._send(B_PING_EOL, false);
        }
        catch (e) {
            if (cbks == this._pingBacks) {
                let idx = cbks.indexOf(evt);
                if (idx >= 0) {
                    cbks.splice(idx, 1);
                }
            }
            evt.rsp = false;
            evt.fail(e);
        }
        evt.wait();
        return evt.rsp;
    }
    /**
     * 检测是否能连通
     */
    pingAsync() {
        return new Promise((r, f) => {
            r(this.ping());
        });
    }
    /**
     * 请求接口
     * @param subject
     * @param payload
     */
    requestAsync(subject, payload, timeoutTtl = 3000) {
        return new Promise((resolve, reject) => {
            let inbox = '_INBOX.' + Nuid_1.nuid.next(), cbk = (rsp, err) => {
                clearTimeout(timer);
                err ? reject(err) : resolve(rsp);
            }, timer = setTimeout(() => {
                subInfo.cancel();
                cbk(null, "nats_request_timeout:" + subject);
            }, timeoutTtl);
            let [subInfo, subCmdBuf] = this._pre_sub_local_first(inbox, cbk, true);
            try {
                this._send(this._pub_blob_3(subCmdBuf, subject, inbox, this.encode(payload)), false);
            }
            catch (e) {
                cbk(null, e);
            }
        });
    }
    /**
     * 同步-请求接口
     * @param subject
     * @param payload
     */
    request(subject, payload, timeoutTtl = 3000) {
        let evt = new WaitTimeoutEvt(timeoutTtl), inbox = '_INBOX.' + Nuid_1.nuid.next();
        let [subInfo, subCmdBuf] = this._pre_sub_local_first(inbox, evt.suc.bind(evt), true);
        try {
            this._send(this._pub_blob_3(subCmdBuf, subject, inbox, this.encode(payload)), false);
            evt.wait();
        }
        catch (e) {
            evt.fail(e);
        }
        if (evt.err) {
            subInfo.cancel();
            if (evt.err === WaitTimeoutEvt.TimeOutErr) {
                evt.err = new Error(`nats_request_timeout:${subject}`);
            }
            throw evt.err;
        }
        return evt.rsp;
    }
    /**
     * 抢占式(queue)侦听主题
     * @param subject
     * @param queue
     * @param callBack
     * @param limit
     */
    queueSubscribe(subject, queue, callBack, limit) {
        let [subInfo, subCommdBuf] = this._pre_sub_local_first(subject, callBack, limit, queue);
        this._send(subCommdBuf, true);
        return subInfo;
    }
    /**
     * 订阅主题
     * @param subject 主题
     * @param callBack 回调函数
     * @param limit 限制执行次数，默认无限次
     * @returns 订阅的编号
     */
    subscribe(subject, callBack, limit) {
        let [subInfo, subCommdBuf] = this._pre_sub_local_first(subject, callBack, limit);
        this._send(subCommdBuf, true);
        return subInfo;
    }
    _pre_sub_local_first(subject, callBack, limit, queue) {
        let sid = Nuid_1.nuid.next(), sobj = {
            subject: subject,
            sid: sid,
            fn: callBack,
            cancel: () => {
                this._unsubscribe_fast(sid, subject);
            }
        };
        if (limit === true) {
            sobj.fast = true;
        }
        else if (limit >= 0) {
            sobj.num = limit;
        }
        this._subs.set(sid, sobj);
        this._subject_incr(subject);
        if (queue) {
            sobj.queue = queue;
            return [sobj, Buffer.from(`SUB ${subject} ${queue} ${sid}${S_EOL}`)];
        }
        return [sobj, Buffer.from(`SUB ${subject} ${sid}${S_EOL}`)];
    }
    _unsubscribe_fast(sid, subject) {
        if (!subject) {
            let sop = this._subs.get(sid);
            if (sop) {
                this._subject_decr(sop.subject);
            }
        }
        else {
            this._subject_decr(subject);
        }
        this._subs.delete(sid);
        this._connection && this._send(Buffer.from(`UNSUB ${sid}${S_EOL}`), false);
    }
    _unsubscribe_fast_mult(sids) {
        let barr = [];
        for (let sid of sids) {
            let sop = this._subs.get(sid);
            if (sop) {
                this._subject_decr(sop.subject);
                this._subs.delete(sid);
                barr.push(Buffer.from(`UNSUB ${sid}${S_EOL}`));
            }
        }
        if (barr.length) {
            this._connection && this._send(Buffer.concat(barr), false);
        }
    }
    //主题-数增加
    _subject_incr(subject) {
        this._tops.set(subject, (this._tops.get(subject) || 0) + 1);
    }
    //主题-数减少
    _subject_decr(subject) {
        let n = this._tops.get(subject);
        if (n > 1) {
            this._tops.set(subject, --n);
        }
        else {
            this._tops.delete(subject);
        }
    }
    _subject_x(subject) {
    }
    /**
     * 取消订阅
     * @param sub 订阅编号
     * @param quantity
     */
    unsubscribe(sub, quantity) {
        let sid = sub.sid ? sub.sid : sub;
        if (this._subs.has(sid)) {
            if (arguments.length < 2) {
                this._unsubscribe_fast(sid);
            }
            else {
                this._send(Buffer.from(`UNSUB ${sid} ${quantity}${S_EOL}`), true);
            }
        }
    }
    /**
     * 取消目标主题的订阅
     * @param subject 主题
     */
    unsubscribeSubject(subject) {
        this._tops && this._tops.delete(subject);
        let barr = [];
        for (let e of this._subs.values()) {
            if (e.subject == subject) {
                barr.push(Buffer.from(`UNSUB ${e.sid}${S_EOL}`));
                this._subs.delete(e.sid);
            }
        }
        if (barr.length) {
            this._send(Buffer.concat(barr), false);
        }
    }
    /**
     * 取消订阅
     * @param subs 订阅编号
     * @param quantity
     */
    unsubscribeMult(subs) {
        let sids = [];
        subs.forEach(sub => {
            sids.push(sub.sid ? sub.sid : sub);
        });
        this._unsubscribe_fast_mult(sids);
    }
    /**
     * 检测-是否订阅过目标主题
     * @param subject
     */
    isSubscribeSubject(subject) {
        if (this._tops) {
            return this._tops.has(subject);
        }
        for (let e of this._subs.values()) {
            if (e.subject == subject) {
                return true;
            }
        }
        return false;
    }
    /**
     * 检测-订阅的目标主题的数量
     * @param subject
     */
    countSubscribeSubject(subject) {
        if (this._tops) {
            return this._tops.get(subject) || 0;
        }
        let n = 0;
        for (let e of this._subs.values()) {
            if (e.subject == subject) {
                n++;
            }
        }
        return n;
    }
    /**
     * 取消所有订阅
     */
    unsubscribeAll() {
        let vals = this._subs.values();
        this._subs = new Map();
        this._tops && this._tops.clear();
        if (this._connection) {
            let barr = [];
            for (let e of vals) {
                barr.push(Buffer.from(`UNSUB ${e.sid}${S_EOL}`));
            }
            if (barr.length) {
                this._send(Buffer.concat(barr), false);
            }
        }
    }
    /**
     * 关闭链接
     */
    close() {
        this._close(true);
    }
    _close(byActive) {
        let flag = this._cfg.reconnect;
        this._cfg.reconnect = false;
        let last = this._connection;
        if (last) {
            this._connection = null;
            last.close();
        }
        this._cfg.reconnect = flag;
        if (byActive) {
            this.unsubscribeAll();
        }
        this._on_pong(true);
    }
    /**
     * 发布数据
     * @param subject 主题
     * @param payload 数据
     */
    publish(subject, payload) {
        // let pb: Class_Buffer = this.encode(payload);this._send(Buffer.concat([B_PUB, Buffer.from(subject), Buffer.from(` ${pb.length}`), B_EOL, pb, B_EOL]), true);
        this._send(this._pub_blob_1(subject, this.encode(payload)), true);
    }
    publishInbox(subject, inbox, payload) {
        this._send(this._pub_blob_2(subject, inbox, this.encode(payload)), true);
    }
    _pub_blob_1(subject, pb) {
        // this._send(Buffer.concat([B_PUB, Buffer.from(subject), Buffer.from(` ${pb.length}`), B_EOL, pb, B_EOL]), true);
        return Buffer.concat([Buffer.from(`${S_PUB} ${subject} ${pb.length} ${S_EOL}`), pb, B_EOL]);
    }
    _pub_blob_2(subject, inbox, pb) {
        // return Buffer.concat([B_PUB, Buffer.from(subject), B_SPACE, Buffer.from(inbox), Buffer.from(` ${pb.length}`), B_EOL, pb, B_EOL]);
        return Buffer.concat([Buffer.from(`${S_PUB} ${subject} ${inbox} ${pb.length} ${S_EOL}`), pb, B_EOL]);
    }
    _pub_blob_3(preCommandBuf, subject, inbox, pb) {
        // return Buffer.concat([B_PUB, Buffer.from(subject), B_SPACE, Buffer.from(inbox), Buffer.from(` ${pb.length}`), B_EOL, pb, B_EOL]);
        return Buffer.concat([preCommandBuf, Buffer.from(`${S_PUB} ${subject} ${inbox} ${pb.length} ${S_EOL}`), pb, B_EOL]);
    }
    _send(payload, retryWhenReconnect) {
        try {
            this._connection.send(payload);
        }
        catch (err) {
            if (this._cfg.reconnect && retryWhenReconnect) {
                this.once(NatsEvent.OnReconnectSuc, () => {
                    this._send(payload, retryWhenReconnect);
                });
            }
            else {
                throw err;
            }
        }
    }
    _on_msg(subject, sid, payload, inbox) {
        let sop = this._subs.get(sid);
        try {
            this._bakIngNum++;
            let data = payload.length > 0 ? this.decode(payload) : null;
            if (sop) {
                if (sop.fast) {
                    this._unsubscribe_fast(sid, sop.subject);
                    sop.fn(data);
                }
                else {
                    let meta = {
                        subject: subject,
                        sid: sid
                    };
                    if (inbox) {
                        meta.reply = (replyData) => {
                            this.publish(inbox, replyData);
                        };
                    }
                    if (sop.num > 0) {
                        if ((--sop.num) == 0) {
                            this._unsubscribe_fast(sid, sop.subject);
                        }
                    }
                    sop.fn(data, meta);
                    this.emit(subject, data);
                }
            }
            else if (inbox) { //队列选了当前执行节点，但是当前节点给取消订阅了
                this.publishInbox(subject, inbox, payload);
            }
        }
        catch (e) {
            console.error("nats|on_msg", e);
            this._bakIngNum--;
        }
    }
    _on_connect(connection, isReconnected) {
        this._connection = connection;
        connection.on("pong", this._on_pong.bind(this));
        connection.on("msg", this._on_msg.bind(this));
        connection.on("close", this._on_lost.bind(this));
        connection.on("ok", this._on_ok.bind(this));
        connection.on("err", this._on_err.bind(this));
        for (let e of this._subs.values()) {
            connection.send(Buffer.from(`SUB ${e.subject} ${e.sid}\r\n`));
        }
        coroutine.start(() => {
            if (this._connection == connection) {
                this.emit(NatsEvent.OnConnect);
                if (isReconnected) {
                    this.emit(NatsEvent.OnReconnectSuc);
                }
            }
        });
    }
    _on_err(evt) {
        console.error("nats_on_err", JSON.stringify(evt), JSON.stringify(this.address));
    }
    _on_ok() {
    }
    _on_lost() {
        let last = this._connection;
        this._close();
        if (last != null) {
            console.error("nats|on_lost => %s", JSON.stringify(last.address));
            this.emit(NatsEvent.OnLost);
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
                a.forEach(e => e.suc(false));
            }
            catch (e) {
                console.error("nats|on_pong", e);
            }
        }
        else {
            let cb = this._pingBacks.shift();
            if (cb) {
                try {
                    cb.suc(true);
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
    set serizalize(c) {
        if (c) {
            this._cfg.serizalize = c;
        }
    }
    get serizalize() {
        return this._cfg.serizalize;
    }
    //构建一个-并主动链接
    static make(cfg, tryInitRetryNum = 9) {
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
                conf.serizalize = exports.NatsSerizalize_Buf;
            }
        }
        return imp._do_connect(Math.max(1, tryInitRetryNum));
    }
}
exports.Nats = Nats;
class NatsEvent {
}
exports.NatsEvent = NatsEvent;
NatsEvent.OnConnect = "connect";
NatsEvent.OnError = "error";
NatsEvent.OnLost = "lost";
NatsEvent.OnReconnectSuc = "reconnect_suc";
NatsEvent.OnReconnectFail = "reconnect_fail";
exports.NatsSerizalize_Json = Object.freeze({
    encode: (payload) => Buffer.from(JSON.stringify(payload)),
    decode: (buf) => JSON.parse(buf.toString())
});
exports.NatsSerizalize_Msgpack = Object.freeze({
    encode: (payload) => encoding_1.msgpack.encode(payload),
    decode: (buf) => encoding_1.msgpack.decode(buf)
});
exports.NatsSerizalize_Str = Object.freeze({
    encode: (payload) => Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)),
    decode: (buf) => buf.toString()
});
exports.NatsSerizalize_Buf = Object.freeze({
    encode: (payload) => Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)),
    decode: (buf) => buf
});
const DefaultAddress = { url: "nats://localhost:4222" };
const DefaultConfig = {
    timeout: 3000,
    reconnect: true,
    reconnectWait: 250,
    maxReconnectAttempts: 86400,
    maxPingOut: 9,
    noEcho: false,
    verbose: false,
    pedantic: false
};
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
        this.echo = !_cfg.noEcho;
        this.verbose = !!_cfg.verbose;
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
    processMsg(buf) {
        // global["log"]("--("+(this._last?this._last.toString():"null")+")-["+buf.toString()+"]-"+buf.toString("hex")+"-\n");
        if (this._last) {
            this._last.append(buf);
            buf = this._last;
            this._last = null;
        }
        let idx, offset = 0;
        while ((idx = buf.indexOf(B_EOL, offset)) > -1) {
            if (idx == 0) {
                buf = buf.slice(2);
                offset = 0;
            }
            else {
                if (buf[1] == BIG_1_MSG) {
                    let line = buf.slice(0, idx), fromIdx = idx + 2;
                    //MSG subject sid size
                    let arr = line.toString().split(" "), len = Number(arr[arr.length - 1]);
                    if (buf.length < (fromIdx + len)) {
                        break;
                    }
                    let endIdx = fromIdx + len, endCloseIdx = endIdx + 2, data = buf.slice(fromIdx, endIdx);
                    buf = buf.slice(buf.length >= endCloseIdx ? endCloseIdx : endIdx);
                    offset = 0;
                    //["msg", subject,sid,data,inbox]
                    this.fire("msg", arr[1], arr[2], data, arr.length > 4 ? arr[3] : null);
                }
                else {
                    if (buf[2] == BIT_2_OK) { // +OK
                        this.fire("ok");
                    }
                    else if (buf[1] == BIT_1_PING) { //PING
                        this.send(B_PONG_EOL);
                    }
                    else if (buf[1] == BIT_1_PONG) { //PONG
                        this.fire("pong");
                    }
                    else if (buf[2] == BIT_2_ERR) { // -ERR
                        let tmp = buf.slice(0, idx).toString().split(" ");
                        this.fire("err", { type: tmp[0], reason: tmp[1] });
                    }
                    buf = buf.slice(idx + 2);
                    offset = 0;
                }
            }
        }
        if (buf.length > offset) {
            this._last = buf.slice(offset);
        }
    }
    static buildConnectCmd(addr, cfg, server_info) {
        let opt = {
            ssl_required: server_info.tls_required && (cfg.ssl ? true : false),
            name: cfg.name,
            lang: exports.LANG,
            version: exports.VERSION,
            echo: !cfg.noEcho,
            verbose: cfg.verbose,
            pedantic: cfg.pedantic,
            protocol: server_info.proto,
        };
        if (server_info.headers) {
            opt.headers = true;
            opt.no_responders = true;
        }
        if (server_info.auth_required) {
            if (cfg.authenticator) {
                //nkey sig jwt
                let tmp = cfg.authenticator(server_info.nonce);
                for (var k in tmp) {
                    opt[k] = tmp[k];
                }
            }
            else if (addr.user && addr.pass) {
                opt.user = addr.user;
                opt.pass = addr.pass;
            }
            else {
                if (addr.token) {
                    opt.auth_token = addr.token;
                }
                if (addr.user) {
                    opt.user = addr.user;
                }
            }
        }
        return Buffer.from(`CONNECT ${JSON.stringify(opt)}\r\n`);
    }
}
class NatsSocket extends NatsConnection {
    constructor(_sock, _cfg, _addr, _info) {
        super(_cfg, _addr, _info);
        this._sock = _sock;
        this._lock = new coroutine.Lock();
        this._state = 1;
        this._reader = coroutine.start(() => {
            let is_fail = (s) => s === null, tmp;
            while (this._state == 1) {
                try {
                    tmp = this._sock.read();
                    if (is_fail(tmp)) {
                        console.error("nats|reading", "read_empty_lost");
                        this._on_lost("read_empty_lost");
                    }
                    else {
                        this.processMsg(tmp);
                    }
                }
                catch (e) {
                    console.error("nats|reading", e);
                    this._on_lost(e.message);
                }
            }
        });
    }
    send(payload) {
        // global["log"]("<--("+payload.toString()+")\n");
        try {
            this._lock.acquire();
            this._sock.write(payload);
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
    static wrapSsl(conn, cfg) {
        if (!cfg.ssl) {
            throw new Error("Nats_no_ssl_config");
        }
        let sock = new ssl.Socket(crypto.loadCert(cfg.ssl.cert), crypto.loadPKey(cfg.ssl.key));
        if (cfg.ssl.ca) {
            ssl.ca.loadFile(cfg.ssl.ca);
        }
        else {
            ssl.loadRootCerts();
        }
        if (!cfg.ssl.ca) {
            sock.verification = ssl.VERIFY_OPTIONAL;
        }
        let v = sock.connect(conn);
        if (v != 0) {
            console.warn("Nats:SSL_verify_fail=%d", v);
        }
        return sock;
    }
    static connect(addr, cfg) {
        let sock;
        let url_obj = url_1.parse(addr.url), addr_str = url_obj.hostname + ":" + (parseInt(url_obj.port) || 4222), addr_timeout = cfg.timeout > 0 ? cfg.timeout : 0;
        let fn_close = () => {
            try {
                sock.close();
            }
            catch (e) {
            }
        };
        let info, auth_err;
        try {
            sock = net.connect("tcp://" + addr_str, addr_timeout);
            sock.timeout = 0;
            let stream = new io_1.BufferedStream(sock);
            stream.EOL = S_EOL;
            let infoStr = stream.readLine(512);
            if (infoStr == null) {
                fn_close();
                throw new Error("closed_while_reading_info");
            }
            info = JSON.parse(infoStr.toString().split(" ")[1]);
            if (info.tls_required) {
                sock = this.wrapSsl(sock, cfg);
                stream = new io_1.BufferedStream(sock);
                stream.EOL = S_EOL;
            }
            sock.write(this.buildConnectCmd(addr, cfg, info));
            if (info.auth_required) {
                stream.writeText("PING\r\n");
                let str = stream.readLine();
                if (str.startsWith("-ERR")) {
                    auth_err = new Error(str.substr(4));
                    throw auth_err;
                }
            }
            return new NatsSocket(sock, cfg, addr, info);
        }
        catch (e) {
            sock && sock.close();
            if (info && info.auth_required) {
                console.error('Nats|open_auth_err,%s,%s', addr.url, e.message);
            }
            else {
                console.error('Nats|open_io_err,%s,%s', addr.url, e.message);
            }
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
    send(payload) {
        // global["log"]("<--("+payload.toString()+")\n");
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
        let sock;
        if (addr.url.startsWith("wss")) {
            let hc = new http.Client();
            hc.poolSize = 0;
            hc.sslVerification = ssl.VERIFY_OPTIONAL;
            if (cfg.ssl) {
                if (cfg.ssl.ca) {
                    ssl.ca.loadFile(cfg.ssl.ca);
                }
                else {
                    ssl.loadRootCerts();
                }
                hc.setClientCert(crypto.loadCert(cfg.ssl.cert), crypto.loadPKey(cfg.ssl.key));
            }
            sock = new ws.Socket(addr.url, { perMessageDeflate: false, httpClient: hc });
        }
        else {
            sock = new ws.Socket(addr.url, { perMessageDeflate: false });
        }
        let svr_info;
        let open_evt = new coroutine.Event();
        let err_info = null;
        sock.once("open", e => {
            sock.off("error");
            open_evt.set();
            sock.once("message", e => {
                svr_info = JSON.parse(e.data.toString().replace("INFO ", "").trim());
                sock.send(this.buildConnectCmd(addr, cfg, svr_info));
                if (!svr_info.auth_required) {
                    open_evt.set();
                }
                else {
                    sock.once("message", e => {
                        let tmp = e.data.toString();
                        if (tmp.includes("-ERR")) {
                            svr_info = null;
                            err_info = tmp.replace("-ERR", "").trim();
                            sock.off("close");
                        }
                        open_evt.set();
                    });
                    sock.send(Buffer.from("PING\r\n"));
                }
            });
            sock.once("close", e => {
                svr_info = null;
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
            else if (svr_info.auth_required) {
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
class WaitEvt extends coroutine.Event {
    suc(v) {
        this.rsp = v;
        this.set();
    }
    fail(e) {
        this.err = e;
        this.set();
    }
}
class WaitTimeoutEvt extends WaitEvt {
    constructor(timeout_ttl) {
        super();
        this.t = setTimeout(() => {
            this.fail(WaitTimeoutEvt.TimeOutErr);
        }, timeout_ttl);
    }
    set() {
        clearTimeout(this.t);
        super.set();
    }
}
WaitTimeoutEvt.TimeOutErr = new Error("wait_time_out_err");
function convertToAddress(uri) {
    let obj = url_1.parse(uri);
    let itf = { ...DefaultAddress, url: String(uri) };
    if (obj.query) {
        let query = queryString.parse(obj.query);
        if (query.first("user")) {
            itf.user = query.first("user");
        }
        if (query.first("pass")) {
            itf.pass = query.first("pass");
        }
        if (query.first("token")) {
            itf.token = query.first("token");
        }
    }
    if (!itf.token && obj.auth && !obj.password) {
        itf.token = obj.auth;
        if (obj.username) {
            itf.user = obj.username;
        }
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
// const B_SPACE = Buffer.from(" ");
const B_EOL = Buffer.from("\r\n");
// const B_PUB = Buffer.from("PUB ");
const B_PING_EOL = Buffer.from("PING\r\n");
const B_PONG_EOL = Buffer.from("PONG\r\n");
const S_EOL = "\r\n";
const S_PUB = "PUB";
const BIT_2_ERR = Buffer.from("-ERR")[2];
const BIT_2_OK = Buffer.from("+OK")[2];
const BIT_1_PING = Buffer.from('PING')[1];
const BIT_1_PONG = Buffer.from('PONG')[1];
const BIG_1_MSG = Buffer.from('MSG')[1];
