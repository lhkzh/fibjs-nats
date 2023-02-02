/// <reference types="@fibjs/types" />

import * as coroutine from "coroutine";
import * as util from "util";
import * as events from "events";
import * as net from "net";
import * as ws from "ws";
import * as ssl from "ssl";
import * as crypto from "crypto";
import * as queryString from "querystring";
import * as http from "http";
import { nuid } from "./Nuid";
import { msgpack } from "encoding";
import { parse } from "url";
import { EventEmitter } from "events";
import { BufferedStream } from "io";

export const VERSION = "1.3.2";
export const LANG = "fibjs";

/**
 * nats客户端实现。支持的地址实现（"nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"）
 * 协议参考
 * https://www.cnblogs.com/liang1101/p/6641348.html
 * https://github.com/repejota/phpnats
 */
export class Nats extends events.EventEmitter {
    private _serverList: Array<NatsAddress> = [];
    private _cfg: NatsConfig;
    private _connection: NatsConnection;

    private _reConnetIng: Class_Event;

    //订阅的编号id-订阅信息
    private _subs: Map<string, NatsSub> = new Map<string, NatsSub>();
    //请求的回调信息
    private _responses: Map<string, Function> = new Map<string, Function>();
    private _pingBacks: Array<WaitEvt<boolean>> = [];
    // private _okWaits: Array<Class_Event> = [];
    //订阅的主题-订阅数量
    private _tops: Map<string, number>;
    private _tops_x: { incr: (subject: string) => void, decr: (subject: string) => void };
    //执行回调中的数量
    private _bakIngNum: number = 0;

    //等待重連中后發送數據的個數
    private _waitToSendNum: number = 0;

    private _mainInbox: string;
    private _mainInbox_pre: string;
    private _nextSid: bigint;

    private _waitOks: Array<[Function, Function]> = [];

    constructor() {
        super();
        this._tops_x = { incr: this._subject_incr.bind(this), decr: this._subject_decr.bind(this) };
        this._subject_incr = this._subject_decr = (subject) => { };
        this._nextSid = 1n;
        this._mainInbox_pre = S_INBOX + nuid.next() + ".";
        this._mainInbox = this._mainInbox_pre + "*";
    }

    /**
     * 开启快速检测-(isSubscribeSubject,countSubscribeSubject)
     */
    public fastCheck() {
        this._subject_incr = this._tops_x.incr;
        this._subject_decr = this._tops_x.decr;
        this._tops = new Map<string, number>();
        return this;
    }

    /**
     * 当前链接的服务器地址
     */
    public get address() {
        return this._connection ? this._connection.address : null;
    }

    /**
     * 当前链接的服务器的信息
     */
    public get info() {
        return this._connection ? this._connection.info : null;
    }

    /**
     * 用于分析当前链接状态
     */
    public toStatJson() {
        return {
            ok: this._connection != null,
            repair: this._reConnetIng != null,
            pingIngNum: this._pingBacks.length,
            subNum: Math.max(0, this._subs.size - 1),
            topicNum: this._tops ? this._tops.size : Math.max(0, this._subs.size - 1),
            bakNum: this._bakIngNum,
            waitToSendNum: this._waitToSendNum
        };
    }

    /**
     * 配置连接地址
     * @param addr  ["nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"]
     */
    public setAllServer(addr: Array<string | NatsAddress> | string | NatsAddress) {
        this._serverList = [];
        if (Array.isArray(addr)) {
            (<Array<string | NatsAddress>>addr).forEach(e => {
                this.addServer(e);
            });
        } else {
            this.addServer(<string>addr);
        }
        return this;
    }

    //添加服务地址
    public addServer(addr: string | NatsAddress) {
        let natAddr = util.isString(addr) ? convertToAddress(<string>addr) : <NatsAddress>addr;
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
    public removeServer(addr: string | NatsAddress) {
        let natAddr = util.isString(addr) ? convertToAddress(<string>addr) : <NatsAddress>addr;
        this._serverList = this._serverList.filter(e => e.url != natAddr.url);
        if (this._connection && this._connection.address.url == natAddr.url) {
            this._close();
            this.reconnect();
        }
        return this;
    }

    //重连
    public reconnect() {
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
        } catch (e) {
            this._reConnetIng = null;
            evt["_err_"] = e;
            evt.set();
            throw e;
        }
    }

    private _do_connect(state: number) {
        let tmps = this._shuffle_server_list();
        let isReconnected = state < 0;
        let retryNum = state > 0 ? state : (this._cfg.maxReconnectAttempts > 0 ? this._cfg.maxReconnectAttempts : 1);
        let suc_connection: NatsConnection;
        M: for (let i = 0; i < retryNum * tmps.length; i++) {
            for (let j = 0; j < tmps.length; j++) {
                let address = tmps[j];
                try {
                    let connection = address.url.startsWith("ws") ? NatsWebsocket.connect(address, this._cfg) : NatsSocket.connect(address, this._cfg);
                    if (connection) {
                        suc_connection = connection;
                        break M;
                    }
                } catch (e) {
                    console.error('Nats|open_fail', address.url, e.message);
                }
                if (isReconnected && (j + 1) == tmps.length) {
                    try {
                        this.emit(NatsEvent.OnReconnectFail, i);
                    } catch (e2) {
                        console.error('Nats|OnReconnectFail_emit', e2);
                    }
                }
                if (this._cfg.reconnectWait > 0) {
                    if (this._cfg.noRandomize) {
                        coroutine.sleep(this._cfg.reconnectWait);
                    } else {
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
        } else {
            this._on_connect(suc_connection, isReconnected);
            return this;
        }
    }

    private _shuffle_server_list() {
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
    public connect() {
        if (this._connection) {
            return this;
        }
        this._do_connect(0);
        return this;
    }

    /**
     * 检测是否能连通
     */
    public ping(): boolean {
        if (!this._connection) {
            return false;
        }
        let cbks = this._pingBacks;
        let evt = new WaitEvt<boolean>();
        cbks.push(evt);
        try {
            this._send(B_PING_EOL, false);
        } catch (e) {
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
    public pingAsync(): Promise<boolean> {
        return new Promise((r, f) => {
            r(this.ping());
        });
    }

    /**
     * 请求接口（非queue方式的，多个侦听回调收集模式）
     * @param subject
     * @param payload
     */
    public requestCollectAsync(subject: string, payload: any, opts: { timeout?: number, wait?: number } = { timeout: 3000, wait: 30 }): Promise<any> {
        const timeoutTtl = opts.timeout || 3000;
        const timeoutWait = opts.wait || 30;
        return new Promise<any>((resolve, reject) => {
            let responses = this._responses, rsp_timer, rsp_arr = [],
                inbox: string,
                cbk = (rsp, _, err) => {
                    if (!rsp_timer) {
                        clearTimeout(timer);
                    }
                    if (err) {
                        responses.delete(inbox);
                        reject(err);
                    } else {
                        rsp_arr.push(rsp);
                        if (!rsp_timer) {
                            rsp_timer = setTimeout(() => {
                                responses.delete(inbox);
                                resolve(rsp_arr);
                            }, timeoutWait);
                        }
                    }
                }, timer: Class_Timer = setTimeout(() => {
                    cbk(null, null, "nats_request_timeout:" + subject);
                }, timeoutTtl);

            try {
                inbox = this._mainInbox_pre + (this._nextSid++).toString();
                responses.set(inbox, cbk);
                this._send(this._pub_blob_2(subject, inbox, this.encode(payload)), false);
            } catch (e) {
                cbk(null, null, e);
            }
        });
    }
    /**
     * 同步-请求接口（非queue方式的，多个侦听回调收集模式）
     * @param subject
     * @param payload
     */
    public requestCollect(subject: string, payload: any, opts: { timeout?: number, wait?: number } = { timeout: 3000, wait: 30 }): any {
        let evt = new WaitTimeout2Evt<any>(opts.timeout || 3000, opts.wait || 30), evt_cbk = evt.cbk(), inbox: string;
        let responses = this._responses;
        try {
            inbox = this._mainInbox_pre + (this._nextSid++).toString();
            responses.set(inbox, evt_cbk);
            this._send(this._pub_blob_2(subject, inbox, this.encode(payload)), false);
            evt.wait();
        } catch (e) {
            evt.fail(e);
        }
        responses.delete(inbox);
        if (evt.err) {
            if (evt.err === WaitTimeoutEvt.TimeOutErr) {
                evt.err = new Error(`nats_request_timeout:${subject}`);
            }
            throw evt.err;
        }
        return evt.rsp;
    }

    /**
     * 请求接口
     * @param subject
     * @param payload
     */
    public requestAsync(subject: string, payload: any, timeoutTtl: number = 3000): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            let responses = this._responses,
                inbox: string,
                cbk = (rsp, _, err) => {
                    clearTimeout(timer);
                    responses.delete(inbox);
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rsp);
                    }
                }, timer: Class_Timer = setTimeout(() => {
                    cbk(null, null, "nats_request_timeout:" + subject);
                }, timeoutTtl);

            try {
                inbox = this._mainInbox_pre + (this._nextSid++).toString();
                responses.set(inbox, cbk);
                this._send(this._pub_blob_2(subject, inbox, this.encode(payload)), false);
            } catch (e) {
                cbk(null, null, e);
            }
        });
    }

    /**
     * 同步-请求接口
     * @param subject
     * @param payload
     */
    public request(subject: string, payload: any, timeoutTtl: number = 3000): any {
        let evt = new WaitTimeoutEvt<any>(timeoutTtl), evt_cbk = evt.cbk(), inbox: string;
        let responses = this._responses;
        try {
            inbox = this._mainInbox_pre + (this._nextSid++).toString();
            responses.set(inbox, evt_cbk);
            this._send(this._pub_blob_2(subject, inbox, this.encode(payload)), false);
            evt.wait();
        } catch (e) {
            evt.fail(e);
        }
        responses.delete(inbox);
        if (evt.err) {
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
    public queueSubscribe(subject: string, queue: string, callBack: SubFn, limit?: number): NatsSub {
        let [subInfo, commandBuf] = this._pre_sub_local_first(subject, callBack, limit, queue);
        this._send(commandBuf, false);
        return subInfo;
    }

    /**
     * 订阅主题
     * @param subject 主题
     * @param callBack 回调函数
     * @param limit 限制执行次数，默认无限次
     * @returns 订阅的编号
     */
    public subscribe(subject: string, callBack: SubFn, limit?: number): NatsSub {
        let [subInfo, commandBuf] = this._pre_sub_local_first(subject, callBack, limit);
        this._send(commandBuf, false);
        return subInfo;
    }

    private _pre_sub_mainInbox() {
        let sid = "0";
        this._subs.set(sid, {
            subject: this._mainInbox, sid: sid,
            fn: (data: any, meta: { subject: string, sid: string }, err?: string) => {
                let f = this._responses.get(meta.subject);
                if (f) {
                    // this._responses.delete(meta.subject);
                    f(data, meta, err);
                } else {
                    console.error("nats-response-miss", meta.subject, JSON.stringify(data));
                }
            },
            cancel: () => {
            }
        });
        return sid;
    }

    private _pre_sub_local_first(subject: string, callBack: SubFn, limit?: number, queue?: string): [NatsSub, Class_Buffer] {
        let sid = (this._nextSid++).toString(),
            sobj: NatsSub = {
                subject: subject,
                sid: sid,
                fn: callBack,
                cancel: () => {
                    this._unsubscribe_fast(sid, subject);
                }
            };
        if (limit >= 0) {
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

    private _unsubscribe_fast(sid: string, subject?: string) {
        if (!subject) {
            let sop = this._subs.get(sid);
            if (sop) {
                this._subject_decr(sop.subject);
            }
        } else {
            this._subject_decr(subject);
        }
        this._subs.delete(sid);
        this._connection && this._send(Buffer.from(`UNSUB ${sid}${S_EOL}`), false);
    }

    private _unsubscribe_fast_mult(sids: string[]) {
        let barr: Class_Buffer[] = [];
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
    private _subject_incr(subject: string) {
        this._tops.set(subject, (this._tops.get(subject) || 0) + 1);
    }

    //主题-数减少
    private _subject_decr(subject: string) {
        let n = this._tops.get(subject);
        if (n > 1) {
            this._tops.set(subject, --n);
        } else {
            this._tops.delete(subject);
        }
    }

    /**
     * 取消订阅
     * @param sub 订阅编号
     * @param after
     */
    public unsubscribe(sub: string | NatsSub, after?: number) {
        let sid = (<NatsSub>sub).sid ? (<NatsSub>sub).sid : <string>sub;
        if (this._subs.has(sid)) {
            if (!Number.isInteger(after) || after < 1) {
                this._unsubscribe_fast(sid);
            } else {
                if (this._subs.get(sid).num > 0) {
                    let t = this._subs.get(sid).num = this._subs.get(sid).num - after;
                    if (t < 1) {
                        this._unsubscribe_fast(sid);
                        return;
                    }
                } else {
                    this._subs.get(sid).num = after;
                }
                try {
                    this._send(Buffer.from(`UNSUB ${sid} ${after}${S_EOL}`), false);
                } catch (ex) {
                    this._unsubscribe_fast(sid);
                }
            }
        }
    }

    /**
     * 取消目标主题的订阅
     * @param subject 主题
     */
    public unsubscribeSubject(subject: string) {
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
    public unsubscribeMult(subs: string[] | NatsSub[] | Set<string> | Set<NatsSub>) {
        let sids: string[] = [];
        subs.forEach(sub => {
            sids.push((<NatsSub>sub).sid ? (<NatsSub>sub).sid : <string>sub)
        })
        this._unsubscribe_fast_mult(sids);
    }

    /**
     * 检测-是否订阅过目标主题
     * @param subject
     */
    public isSubscribeSubject(subject: string): boolean {
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
    public countSubscribeSubject(subject: string): number {
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
    public unsubscribeAll() {
        let vals = this._subs.values();
        this._subs = new Map<string, NatsSub>();
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
    public close() {
        this._close(true);
    }

    private _close(byActive?: boolean) {
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
        let b = this._responses;
        this._responses = new Map<string, Function>();
        this._on_pong(true);
        let e = new Error("nats|on_lost");
        b.forEach(f => {
            f(null, null, e);
        });
        this._reject_waitOks("connect_on_close");
    }

    /**
     * 发布数据
     * @param subject 主题
     * @param payload 数据
     */
    public publish(subject: string, payload?: any, retryWhenReconnect?: boolean) {
        // let pb: Class_Buffer = this.encode(payload);this._send(Buffer.concat([B_PUB, Buffer.from(subject), Buffer.from(` ${pb.length}`), B_EOL, pb, B_EOL]), true);
        this._send(this._pub_blob_1(subject, this.encode(payload)), retryWhenReconnect);
    }

    public publishInbox(subject: string, inbox: string, payload: any, retryWhenReconnect?: boolean) {
        this._send(this._pub_blob_2(subject, inbox, this.encode(payload)), retryWhenReconnect);
    }

    private _pub_blob_1(subject: string, pb: Class_Buffer) {
        // this._send(Buffer.concat([B_PUB, Buffer.from(subject), Buffer.from(` ${pb.length}`), B_EOL, pb, B_EOL]), true);
        return Buffer.concat([Buffer.from(`${S_PUB} ${subject} ${pb.length} ${S_EOL}`), pb, B_EOL]);
    }

    private _pub_blob_2(subject: string, inbox: string, pb: Class_Buffer) {
        // return Buffer.concat([B_PUB, Buffer.from(subject), B_SPACE, Buffer.from(inbox), Buffer.from(` ${pb.length}`), B_EOL, pb, B_EOL]);
        return Buffer.concat([Buffer.from(`${S_PUB} ${subject} ${inbox} ${pb.length} ${S_EOL}`), pb, B_EOL]);
    }

    /**
     * 多条合批发布
     * @param list
     * @param retryWhenReconnec
     */
    public publishMult(list: Array<{ subject: string, payload?: any }>, retryWhenReconnec = false) {
        let bufs: Class_Buffer[] = [], pb: Class_Buffer;
        for (var e of list) {
            pb = this.encode(e.payload);
            bufs.push(Buffer.from(`${S_PUB} ${e.subject} ${pb.length} ${S_EOL}`), pb, B_EOL);
        }
        this._send(Buffer.concat(bufs), retryWhenReconnec);
    }
    /**
     * if you config "verbose:true", wait real "ok"
     */
    public waitOkAsync() {
        return new Promise((resolve, reject) => {
            if (!this._connection) {
                reject("client not connected");
            } else {
                if (!this._cfg.verbose) {
                    resolve(null);
                } else {
                    this._waitOks.push([resolve, reject]);
                }
            }
        });
    }
    /**
     * if you config "verbose:true", wait real "ok"
     */
    public waitOk(): boolean {
        let lock = new coroutine.Semaphore(0), lerr;
        this.waitOkAsync().then(() => {
            lock.post();
        }).catch(err => {
            lock.post();
            lerr = err;
        });
        lock.wait();
        if (lerr) {
            return false;
        }
        return true;
    }

    protected _send(payload, retryWhenReconnect: boolean) {
        try {
            this._connection.send(payload);
        } catch (err) {
            if (this._cfg.reconnect && retryWhenReconnect) {
                let _failNum = 0;
                let _suc = () => {
                    _cancel();
                    this._send(payload, retryWhenReconnect);
                };
                let _fail = () => {
                    _failNum++;
                    if (_failNum > this._cfg.waitToSendLimitMaxFail)
                        _cancel();
                };
                let _cancel = () => {
                    this._waitToSendNum--;
                    this.off(NatsEvent.OnReconnectSuc, _suc);
                    this.off(NatsEvent.OnReconnectFail, _fail);
                }
                this.once(NatsEvent.OnReconnectSuc, _suc);
                this.once(NatsEvent.OnReconnectFail, _fail);
                this._waitToSendNum++;
            } else {
                throw err;
            }
        }
    }

    protected _on_msg(subject: string, sid: string, payload: Class_Buffer, inbox: string) {
        let sop = this._subs.get(sid);
        try {
            this._bakIngNum++;
            let data = payload.length > 0 ? this.decode(payload) : null;
            if (sop) {
                let meta: { subject: string, sid: string, reply?: (replyData: any) => void } = {
                    subject: subject,
                    sid: sid
                };
                if (inbox) {
                    meta.reply = (replyData) => {
                        this.publish(inbox, replyData, true);
                    };
                }
                if (sop.num > 0) {
                    if ((--sop.num) == 0) {
                        this._unsubscribe_fast(sid, sop.subject);
                    }
                }
                sop.fn(data, meta);
                if (this._cfg.subjectAsEvent) {
                    this.emit(subject, data);
                }
            } else if (inbox) {//队列选了当前执行节点，但是当前节点给取消订阅了
                this.publishInbox(subject, inbox, payload, true);
            }
        } catch (e) {
            console.error("nats|on_msg", e);
        } finally {
            this._bakIngNum--;
        }
    }

    protected _on_hmsg(subject: string, sid: string, payload: Class_Buffer) {
        let sop = this._subs.get(sid);
        try {
            this._bakIngNum++;
            if (sop) {
                (<any>sop.fn)(null, { subject: subject }, new Error(payload.toString()));
            }
        } catch (e) {
            console.error("nats|on_hmsg", e);
        } finally {
            this._bakIngNum--;
        }
    }

    private _on_connect(connection: NatsConnection, isReconnected) {
        this._connection = connection;
        connection.on("close", this._on_lost.bind(this));
        connection.on("err", this._on_err.bind(this));
        connection.on("pong", this._on_pong.bind(this));
        // connection.on("ok", this._on_ok.bind(this));
        // connection.on("msg", this._on_msg.bind(this));
        // connection.on("hmsg", this._on_hmsg.bind(this));
        connection._on_ok = this._on_ok.bind(this);
        connection._on_msg = this._on_msg.bind(this);
        connection._on_hmsg = this._on_hmsg.bind(this);
        let tmpArr = [`SUB ${this._mainInbox} ${this._pre_sub_mainInbox()}${S_EOL}`];
        for (let e of this._subs.values()) {
            if (e.queue) {
                tmpArr.push(`SUB ${e.subject} ${e.queue} ${e.sid}${S_EOL}`)
            } else {
                tmpArr.push(`SUB ${e.subject} ${e.sid}${S_EOL}`);
            }
            if (tmpArr.length % 100 == 0) {
                connection.send(Buffer.from(tmpArr.join('')));
                tmpArr.length = 0;
            }
        }
        if (tmpArr.length) {
            connection.send(Buffer.from(tmpArr.join('')));
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

    private _on_err(evt: { type: string, reason: string }) {
        console.error("nats_on_err", JSON.stringify(evt), JSON.stringify(this.address));
    }
    protected _on_ok() {
        if (this._waitOks.length > 0) {
            let fns = this._waitOks.shift();
            try {
                fns[0](null);
            } catch (err) {
                console.error(`process_nats:waitok`, err);
            }
        }
    }
    private _reject_waitOks(info) {
        if (this._waitOks.length > 0) {
            let tmps = this._waitOks.concat();
            this._waitOks.length = 0;
            tmps.forEach(fns => {
                try {
                    fns[1](info);
                } catch (err) {
                    console.error(`process_nats:waitok-reject`, err);
                }
            })
        }
    }

    private _on_lost() {
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

    protected _on_pong(is_lost: boolean) {
        if (is_lost) {
            let a = this._pingBacks;
            this._pingBacks = [];
            try {
                a.forEach(e => e.suc(false));
            } catch (e) {
                console.error("nats|on_pong", e)
            }
        } else {
            let cb = this._pingBacks.shift();
            if (cb) {
                try {
                    cb.suc(true);
                } catch (e) {
                    console.error("nats|on_pong", e)
                }
            }
        }
    }

    protected encode(payload: any): Class_Buffer {
        return this._cfg.serizalize.encode(payload);
    }

    protected decode(data: Class_Buffer): any {
        return this._cfg.serizalize.decode(data);
    }

    public set serizalize(c: NatsSerizalize) {
        if (c) {
            this._cfg.serizalize = c;
        }
    }

    public get serizalize(): NatsSerizalize {
        return this._cfg.serizalize;
    }

    //构建一个-并主动链接
    public static make(cfg: string | NatsAddress | NatsConnectCfg = "nats://127.0.0.1:4222", tryInitRetryNum: number = 9) {
        if (typeof cfg == "string") {
            cfg = { url: cfg.toString() };
        }
        let imp = new Nats();
        let conf: NatsConfig;
        if ((<NatsConnectCfg_Mult>cfg).servers) {
            (<NatsConnectCfg_Mult>cfg).servers.forEach(e => {
                imp.addServer(e);
            });
            conf = { ...DefaultConfig, ...cfg };
            delete conf["servers"];
        } else if (typeof ((<NatsConnectCfg_One>cfg).url) != "string" || Object.values(cfg).some(e => typeof (e) != "string")) {
            imp.addServer((<NatsConnectCfg_One>cfg).url);
            conf = { ...DefaultConfig, ...cfg };
            delete conf["url"];
        } else {
            imp.addServer(<NatsAddress>cfg);
        }
        imp._cfg = conf || { ...DefaultConfig };
        if (imp._cfg.serizalize == null) {
            if (imp._cfg["json"]) {
                imp._cfg.serizalize = NatsSerizalize_Json;
            } else if (imp._cfg["msgpack"]) {
                imp._cfg.serizalize = NatsSerizalize_Msgpack;
            } else {
                imp._cfg.serizalize = NatsSerizalize_Buf;
            }
        }
        return imp._do_connect(Math.max(1, tryInitRetryNum));
    }
}

export class NatsEvent {
    public static OnConnect = "connect";
    public static OnError = "error";
    public static OnLost = "lost";
    public static OnReconnectSuc = "reconnect_suc";
    public static OnReconnectFail = "reconnect_fail";
}

//侦听器-回调
type SubFn = (data: any, meta?: { subject: string, sid: string, reply?: (replyData: any) => void }) => void;
//侦听器-结构描述
export type NatsSub = { subject: string, sid: string, fn: SubFn, num?: number, queue?: string, cancel: () => void };

/**
 * 服务器信息描述
 */
export interface NatsServerInfo {
    server_id: string;
    server_name: string;
    version: string;
    proto: number,
    go: string;
    max_payload: number;
    tls_required: boolean;
    tls_verify: boolean;

    host: string;
    port: number;
    client_id: number;
    client_ip: string,

    headers: boolean,
    auth_required?: boolean;
    nonce?: string;
}

/**
 * 服务器地址配置
 */
export interface NatsAddress {
    url?: string
    //授权user
    user?: string,
    //授权pass
    pass?: string,
    //授权token
    token?: string,
}

export interface NatsConfig {
    //socket链接超时时间ms
    timeout?: number,
    //计时进行ping服务器
    pingInterval?: number,
    maxPingOut?: number,
    //是否开启重连，默认true
    reconnect?: boolean,
    //重连暂停时间
    reconnectWait?: number,
    //是否禁用-重连时间随机
    noRandomize?: boolean,
    //重连最大次数
    maxReconnectAttempts?: number,
    //等待发送限制最大重连次数（等待-重連成功發送-限制等少次）
    waitToSendLimitMaxFail?: number,

    //name=客户端连接名字,
    name?: string,
    //是否关闭连接自己发出去的消息-回显订阅
    noEcho?: boolean,
    verbose?: boolean,
    pedantic?: boolean,

    //序列化方式
    serizalize?: NatsSerizalize,
    json?: boolean,
    msgpack?: boolean,

    //tls证书配置
    ssl?: { name?: string, ca?: string, cert?: string, key?: string },

    //特殊认证
    authenticator?: (nonce?: string) => { nkey?: string, sig: string, jwt?: string, auth_token?: string, user?: string, pass?: string },

    //subject_fire_event
    subjectAsEvent?: boolean
}

type NatsConnectCfg_Mult = NatsConfig & { servers?: Array<string | NatsAddress> };
type NatsConnectCfg_One = NatsConfig & { url?: string | NatsAddress };
type NatsConnectCfg = NatsConnectCfg_Mult | NatsConnectCfg_One;

export type NatsSerizalize = { encode: (payload: any) => Class_Buffer, decode: (buf: Class_Buffer) => any };
export const NatsSerizalize_Json: NatsSerizalize = Object.freeze({
    encode: (payload: any) => Buffer.from(JSON.stringify(payload)),
    decode: (buf: Class_Buffer) => JSON.parse(buf.toString())
});
export const NatsSerizalize_Msgpack: NatsSerizalize = Object.freeze({
    encode: (payload: any) => msgpack.encode(payload),
    decode: (buf: Class_Buffer) => msgpack.decode(buf)
});
export const NatsSerizalize_Str: NatsSerizalize = Object.freeze({
    encode: (payload: any) => Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)),
    decode: (buf: Class_Buffer) => buf.toString()
});
export const NatsSerizalize_Buf: NatsSerizalize = Object.freeze({
    encode: (payload: any) => Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)),
    decode: (buf: Class_Buffer) => buf
});

const DefaultAddress: NatsAddress = { url: "nats://localhost:4222" };
const DefaultConfig: NatsConfig = {
    timeout: 3000,
    reconnect: true,
    reconnectWait: 250,
    maxReconnectAttempts: 86400,
    maxPingOut: 9,
    waitToSendLimitMaxFail: 9,
    noEcho: false,
    verbose: false,
    pedantic: false
};

abstract class NatsConnection extends EventEmitter {
    protected _state: number;
    protected _pingTimer: Class_Timer;
    protected _pingIng: number;

    public echo: boolean;
    public verbose: boolean;

    public _on_msg: Function;
    public _on_hmsg: Function;
    public _on_ok: Function;

    constructor(protected _cfg: NatsConfig, protected _addr: NatsAddress, protected _info: NatsServerInfo) {
        super();
        if (this._cfg.pingInterval > 0 && this._cfg.maxPingOut > 0) {
            this._pingIng = 0;
            this._do_ping();
        }
        this.echo = !_cfg.noEcho;
        this.verbose = !!_cfg.verbose;
    }

    private _do_ping() {
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
        } catch (e) {
            clearTimeout(this._pingTimer);
        }
    }

    public get address(): NatsAddress {
        return this._addr;
    }

    public get info(): NatsServerInfo {
        return this._info;
    }

    protected fire(evt: string, ...args) {
        try {
            this.emit(evt, ...args);
        } catch (e) {
            console.error(`process_nats:${evt}`, e);
        }
    }

    abstract send(payload: Class_Buffer): void;

    protected _fn_close() {

    }

    protected _on_lost(reason: string = "") {
        if (this._state == 1) {
            this._state = 3;
            try {
                this._fn_close();
            } catch (e) {
            }
            this.emit("close", { type: "close", code: 888, reason: reason });
        }
    }

    public close() {
        this._on_lost("close");
        this.eventNames().forEach(e => {
            this.off(e);
        })
    }

    protected _last: Class_Buffer;

    protected processMsg(buf: Class_Buffer) {
        // global["log"]("--("+(this._last?this._last.toString():"null")+")-["+buf.toString()+"]-"+buf.toString("hex")+"-\n");
        if (this._last) {
            this._last.append(buf);
            buf = this._last;
            this._last = null;
        }
        let idx: number, offset = 0;
        while ((idx = buf.indexOf(B_EOL, offset)) > -1) {
            if (idx == 0) {
                buf = buf.slice(2);
                offset = 0;
            } else {
                if (buf[1] == BIG_1_MSG) {//MSG
                    let line = buf.slice(0, idx), fromIdx = idx + 2;
                    //MSG subject sid size
                    let arr = line.toString().split(" "),
                        len: number = Number(arr[arr.length - 1]);
                    if (buf.length < (fromIdx + len)) {
                        break;
                    }
                    let endIdx = fromIdx + len, endCloseIdx = endIdx + 2, data = buf.slice(fromIdx, endIdx);
                    buf = buf.slice(buf.length >= endCloseIdx ? endCloseIdx : endIdx);
                    offset = 0;
                    //["msg", subject,sid,data,inbox]
                    // this.fire("msg", arr[1], arr[2], data, arr.length > 4 ? arr[3] : null);
                    try {
                        this._on_msg(arr[1], arr[2], data, arr.length > 4 ? arr[3] : null);
                    } catch (e) {
                        console.error(`process_nats:msg:${arr[1]}`, e);
                    }
                } else if (buf[1] == BIG_1_HMSG) {
                    let line = buf.slice(0, idx), fromIdx = idx + 2;
                    let arr = line.toString().split(" "),
                        len: number = Number(arr[arr.length - 1]);
                    if (buf.length < (fromIdx + len)) {
                        break;
                    }
                    let endIdx = fromIdx + len, endCloseIdx = endIdx + 2, data = buf.slice(fromIdx, endIdx);
                    buf = buf.slice(buf.length >= endCloseIdx ? endCloseIdx : endIdx);
                    offset = 0;
                    // console.log("["+data.toString()+"]", arr[1], arr[2])
                    try {
                        this._on_hmsg(arr[1], arr[2], data, arr.length > 4 ? arr[3] : null);
                    } catch (e) {
                        console.error(`process_nats:msg:${arr[1]}`, e);
                    }
                } else {
                    if (buf[2] == BIT_2_OK) {// +OK
                        // this.fire("ok");
                        this._on_ok();
                    } else if (buf[1] == BIT_1_PING) {//PING
                        this.send(B_PONG_EOL);
                    } else if (buf[1] == BIT_1_PONG) {//PONG
                        this.fire("pong");
                    } else if (buf[2] == BIT_2_ERR) {// -ERR
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

    protected static buildConnectCmd(addr: NatsAddress, cfg: NatsConfig, server_info: NatsServerInfo) {
        let opt: any = {
            ssl_required: server_info.tls_required && (cfg.ssl ? true : false),
            name: cfg.name,
            lang: LANG,
            version: VERSION,
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
                let tmp = <any>cfg.authenticator(server_info.nonce);
                for (var k in tmp) {
                    opt[k] = tmp[k];
                }
            } else if (addr.user && addr.pass) {
                opt.user = addr.user;
                opt.pass = addr.pass;
            } else {
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
    // private _lock: Class_Lock;
    protected _reader: Class_Fiber;

    constructor(private _sock: Class_Socket, _cfg: NatsConfig, _addr: NatsAddress, _info: NatsServerInfo) {
        super(_cfg, _addr, _info);
        // this._lock = new coroutine.Lock();
        this._state = 1;
        this._reader = coroutine.start(() => {
            let is_fail = (s: Class_Buffer | string) => s === null, tmp: Class_Buffer;
            while (this._state == 1) {
                try {
                    tmp = this._sock.read();
                    if (is_fail(tmp)) {
                        console.error("nats|reading", "read_empty_lost");
                        this._on_lost("read_empty_lost");
                    } else {
                        this.processMsg(tmp);
                    }
                } catch (e) {
                    console.error("nats|reading", e);
                    this._on_lost(e.message);
                }
            }
        });
    }

    public send(payload: Class_Buffer) {
        // global["log"]("<--("+payload.toString()+")\n");
        try {
            // this._lock.acquire();
            this._sock.write(payload);
            // this._lock.release();
        } catch (e) {
            // this._lock.release();
            this._on_lost(e.message);
            throw e;
        }
    }

    protected _fn_close() {
        this._sock.close();
    }

    private static wrapSsl(conn: Class_Socket, cfg: NatsConfig) {
        if (!cfg.ssl) {
            throw new Error("Nats_no_ssl_config");
        }
        let sock = new ssl.Socket(crypto.loadCert(cfg.ssl.cert), crypto.loadPKey(cfg.ssl.key));
        if (cfg.ssl.ca) {
            ssl.ca.loadFile(cfg.ssl.ca);
        } else {
            ssl.loadRootCerts();
        }
        if (!cfg.ssl.ca) {
            sock.verification = ssl.VERIFY_OPTIONAL;
        }
        let v = sock.connect(conn);
        if (v != 0) {
            console.warn("Nats:SSL_verify_fail=%d", v);
        }
        return <any>sock;
    }

    public static connect(addr: NatsAddress, cfg: NatsConfig): NatsConnection {
        let sock: Class_Socket;
        let url_obj = parse(addr.url), addr_str = url_obj.hostname + ":" + (parseInt(url_obj.port) || 4222),
            addr_timeout = cfg.timeout > 0 ? cfg.timeout : 0;
        let fn_close = () => {
            try {
                sock.close();
            } catch (e) {
            }
        }
        let info: NatsServerInfo, auth_err: Error;
        try {
            sock = <any>net.connect("tcp://" + addr_str, addr_timeout);
            sock.timeout = -1;
            let stream = new BufferedStream(sock);
            stream.EOL = S_EOL;
            let infoStr = stream.readLine();
            if (infoStr == null) {
                fn_close();
                throw new Error("closed_while_reading_info");
            }
            info = JSON.parse(infoStr.toString().substring(5));
            if (info.tls_required) {
                sock = this.wrapSsl(sock, cfg);
                stream = new BufferedStream(sock);
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
        } catch (e) {
            sock && sock.close();
            if (info && info.auth_required) {
                console.error('Nats|open_auth_err,%s,%s', addr.url, e.message);
            } else {
                console.error('Nats|open_io_err,%s,%s', addr.url, e.message);
            }
        }
        return null;
    }
}

class NatsWebsocket extends NatsConnection {
    constructor(private _sock: Class_WebSocket, _cfg: NatsConfig, _addr: NatsAddress, _info: NatsServerInfo) {
        super(_cfg, _addr, _info);
        this._state = 1;
        _sock.onclose = e => {
            this._on_lost(e.reason);
        }
        _sock.onmessage = e => {
            this.processMsg(<Class_Buffer>e.data)
        };
    }

    public send(payload: Class_Buffer) {
        // global["log"]("<--("+payload.toString()+")\n");
        try {
            this._sock.send(payload);
        } catch (e) {
            this._on_lost(e.message);
            throw e;
        }
    }

    protected _fn_close() {
        this._sock.close();
    }

    public static connect(addr: NatsAddress, cfg: NatsConfig): NatsConnection {
        let sock: Class_WebSocket;
        if (addr.url.startsWith("wss")) {
            let hc = new http.Client();
            hc.poolSize = 0;
            hc.sslVerification = ssl.VERIFY_OPTIONAL;
            if (cfg.ssl) {
                if (cfg.ssl.ca) {
                    ssl.ca.loadFile(cfg.ssl.ca);
                } else {
                    ssl.loadRootCerts();
                }
                hc.setClientCert(crypto.loadCert(cfg.ssl.cert), crypto.loadPKey(cfg.ssl.key));
            }
            sock = new ws.Socket(addr.url, { perMessageDeflate: false, httpClient: hc });
        } else {
            sock = new ws.Socket(addr.url, { perMessageDeflate: false });
        }
        let svr_info: NatsServerInfo;
        let open_evt = new coroutine.Event();
        let err_info: string = null;
        sock.once("open", e => {
            sock.off("error");
            open_evt.set();
            sock.once("message", e => {
                svr_info = JSON.parse(e.data.toString().replace("INFO ", "").trim());
                sock.send(this.buildConnectCmd(addr, cfg, svr_info));
                if (!svr_info.auth_required) {
                    open_evt.set();
                } else {
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
            } else if (svr_info.auth_required) {
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

class WaitEvt<T> extends coroutine.Event {
    public rsp: T;
    public err: Error | string;

    public suc(v: T) {
        this.rsp = v;
        this.set();
    }

    public fail(e: Error | string) {
        this.err = e;
        this.set();
    }
}

class WaitTimeoutEvt<T> extends WaitEvt<T> {
    public static TimeOutErr: Error = new Error("wait_time_out_err");
    private t: Class_Timer;

    constructor(timeout_ttl: number) {
        super();
        this.t = setTimeout(() => {
            this.fail(WaitTimeoutEvt.TimeOutErr);
        }, timeout_ttl);
    }

    public set() {
        clearTimeout(this.t);
        super.set();
    }

    public cbk() {
        return (d, _, e) => {
            if (e) {
                this.fail(e);
            } else {
                this.suc(d);
            }
        }
    }
}
class WaitTimeout2Evt<T> extends coroutine.Event {
    public rsp: T[] = [];
    public err: Error | string;

    private t1: Class_Timer;
    private t2: Class_Timer;

    constructor(timeout_ttl: number, private timeout_wait_ttl: number) {
        super();
        this.t1 = setTimeout(() => {
            this.fail(WaitTimeoutEvt.TimeOutErr);
        }, timeout_ttl);
    }
    public suc(v: T) {
        this.rsp.push(v);
        if (this.rsp.length == 1) {
            clearTimeout(this.t1);
            this.t2 = setTimeout(() => {
                clearTimeout(this.t2);
                this.set();
            }, this.timeout_wait_ttl)
        }
    }
    public fail(e: Error | string) {
        clearTimeout(this.t1);
        this.err = e;
        this.set();
    }
    public cbk() {
        return (d, _, e) => {
            if (e) {
                this.fail(e);
            } else {
                this.suc(d);
            }
        }
    }
}

function convertToAddress(uri: string) {
    let obj = parse(uri);
    let itf: NatsAddress = { ...DefaultAddress, url: String(uri) };
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
    } else if (!itf.user && obj.username && obj.password) {
        itf.user = obj.username;
        itf.pass = obj.password;
    }
    let auth_str = "";
    if (itf.token) {
        auth_str = itf.token + "@";
    } else if (itf.user) {
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
const S_INBOX = "_INBOX.";

const BIT_2_ERR: number = Buffer.from("-ERR")[2];
const BIT_2_OK: number = Buffer.from("+OK")[2];
const BIT_1_PING: number = Buffer.from('PING')[1];
const BIT_1_PONG: number = Buffer.from('PONG')[1];
const BIG_1_MSG: number = Buffer.from('MSG')[1];
const BIG_1_HMSG: number = Buffer.from('HMSG')[1];