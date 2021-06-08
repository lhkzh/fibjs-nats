/// <reference types="@fibjs/types" />

import * as coroutine from "coroutine";
import * as util from "util";
import * as events from "events";
import * as net from "net";
import * as ws from "ws";
import * as ssl from "ssl";
import {nuid} from "./Nuid";
import {msgpack} from "encoding";
import {parse} from "url";
import * as queryString from "querystring";
import {EventEmitter} from "events";
import { BufferedStream,MemoryStream } from "io";

export const VERSION = "1.1.0";
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

    private subscriptions: Map<string, SubInfo> = new Map<string, SubInfo>();
    private _pingBacks: Array<WaitEvt<boolean>> = [];
    private _okWaits: Array<Class_Event> = [];

    // private autoReconnect: boolean;
    private _reConnetIng: Class_Event;

    constructor() {
        super();
        this._serverList = [];
    }

    public get address(){
        return this._connection?this._connection.address:null;
    }
    public get info() {
        return this._connection?this._connection.info:null;
    }

    /**
     * 配置连接地址
     * @param addr  ["nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"]
     */
    public setAllServer(addr: Array<string|NatsAddress> | string | NatsAddress) {
        this._serverList = [];
        if(Array.isArray(addr)){
            (<Array<string|NatsAddress>>addr).forEach(e=>{
                this.addServer(e);
            });
        }else {
            this.addServer(<string>addr);
        }
        return this;
    }

    //添加服务地址
    public addServer(addr: string | NatsAddress) {
        let natAddr = util.isString(addr) ? convertToAddress(<string>addr):<NatsAddress>addr;
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
    public removeServer(addr: string|NatsAddress) {
        let natAddr = util.isString(addr) ? convertToAddress(<string>addr):<NatsAddress>addr;
        this._serverList = this._serverList.filter(e=>e.url!=natAddr.url);
        if (this._connection && this._connection.address.url==natAddr.url) {
            this.close();
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
            this.close();
            this._do_connect(true);
            this._reConnetIng = null;
            evt.set();
        } catch (e) {
            this._reConnetIng = null;
            evt["_err_"] = e;
            evt.set();
            throw e;
        }
    }

    private _do_connect(isReconnect:boolean){
        let tmps = this._shuffle_server_list();
        let retryNum = this._cfg.maxReconnectAttempts > 0?this._cfg.maxReconnectAttempts:1;
        let suc_connection:NatsConnection;
        M:for (let i = 0; i < retryNum*tmps.length; i++) {
            for (let j = 0; j < tmps.length; j++) {
                let address = tmps[j];
                try {
                    let connection = address.url.startsWith("ws") ? NatsWebsocket.connect(address, this._cfg):NatsSocket.connect(address, this._cfg);
                    if(connection){
                        suc_connection = connection;
                        break M;
                    }
                } catch (e) {
                    console.error('Nats|open_fail', address.url, e.message);
                }
                if(this._cfg.reconnectWait>0){
                    if(this._cfg.noRandomize){
                        coroutine.sleep(this._cfg.reconnectWait);
                    }else{
                        coroutine.sleep(this._cfg.reconnectWait+Math.ceil(Math.random()*50));
                    }
                }
            }
        }
        if (suc_connection == null) {
            this.emit(NatsEvent.OnIoError, "connect_nats_fail", JSON.stringify(this._serverList));
            let err = new Error("connect_nats_fail");
            console.log("nats|connect", err.message);
            throw err;
        }else{
            this._on_connect(suc_connection, isReconnect);
            return this;
        }
    }
    private _shuffle_server_list(){
        let a = this._serverList.concat();
        if(a.length<1){
            a = [{...DefaultAddress}];
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
        if(this._connection){
            return this;
        }
        this._do_connect(false);
        return this;
    }

    /**
     * 检测是否能连通
     */
    public ping(): boolean {
        if (!this._connection) {
            return false;
        }
        try {
            this._send(B_PING_EOL, false);
            let evt = new WaitEvt<boolean>()
            this._pingBacks.push(evt);
            evt.wait();
            return evt.rsp;
        } catch (e) {
            return false;
        }
    }

    /**
     * 请求接口
     * @param subject
     * @param payload
     */
    public request(subject: string, payload: any, timeoutTtl: number = 3000): Promise<any> {
        let self = this, sid, subs = self.subscriptions, timeout;
        return new Promise<any>((resolve, reject) => {
            try {
                let inbox = '_INBOX.' + nuid.next();
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
            } catch (e) {
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
    public requestSync(subject: string, payload: any, timeoutTtl: number = 3000): any {
        let self = this,
            subs = this.subscriptions,
            inbox = '_INBOX.' + nuid.next(),
            evt = new coroutine.Event(false),
            isTimeouted, timeout: Class_Timer, sid: string, rsp: any
        ;

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
                } catch (e) {
                }
            }, timeoutTtl);
            this.publish(subject, payload, inbox);
        } catch (e) {
            if (sid) {
                subs.delete(sid);
                if (timeout) {
                    clearTimeout(timeout);
                    try {
                        this.unsubscribe(inbox);
                    } catch (e) {
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
    public queueSubscribe(subject: string, queue: string, callBack: SubFn, limit?: number): string {
        return this.subscribe(subject + ' ' + queue, callBack, limit);
    }

    /**
     * 订阅主题
     * @param subject 主题
     * @param callBack 回调函数
     * @param limit 限制执行次数，默认无限次
     * @returns 订阅的编号
     */
    public subscribe(subject: string, callBack: SubFn, limit?: number): string {
        let sid = nuid.next();
        this.subscriptions.set(sid, {
            subject: subject,
            sid: sid,
            fn: callBack,
            num: limit > 0 ? limit : -1
        });
        this._send(Buffer.from(`SUB ${subject} ${sid}${S_EOL}`), true);
        return sid;
    }

    /**
     * 取消订阅
     * @param sid 订阅编号
     * @param quantity
     */
    public unsubscribe(sid: string, quantity?: number) {
        let msg = Buffer.from(arguments.length > 1 ? `UNSUB ${sid} ${quantity}${S_EOL}` : `UNSUB ${sid}${S_EOL}`);
        if (arguments.length < 2) {
            this.subscriptions.delete(sid);
            this._send(Buffer.from(msg), false);
        }else{
            this._send(Buffer.from(msg), true);
        }
    }

    /**
     * 取消目标主题的订阅
     * @param subject 主题
     */
    public unsubscribeSubject(subject: string) {
        for(let e of this.subscriptions.values()){
            if (e.subject == subject) {
                this.unsubscribe(e.sid);
            }
        }
    }

    /**
     * 取消所有订阅
     */
    public unsubscribeAll() {
        let vals = this.subscriptions.values();
        this.subscriptions = new Map<string, SubInfo>();
        if (!this._connection) {
            return;
        }
        for(let e of vals){
            try {
                this.unsubscribe(e.sid);
            } catch (e) {
            }
        }
    }

    /**
     * 关闭链接
     */
    public close() {
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
    public publish(subject: string, payload?: any, inbox?: string) {
        let arr: Array<any> = [B_PUB, Buffer.from(subject)];
        if (inbox) {
            arr.push(B_SPACE, Buffer.from(inbox));
        }
        if (payload != null) {
            let pb: Class_Buffer = this.encode(payload);
            arr.push(Buffer.from(` ${pb.length}`), B_EOL, pb, B_EOL);
        } else {
            arr.push(B_PUBLISH_EMPTY)
        }
        this._send(Buffer.concat(arr), true);
    }

    protected _send(payload, retryWhenReconnect:boolean) {
        try {
            this._connection.send(payload);
        } catch (err) {
            if (this._cfg.reconnect && retryWhenReconnect) {
                this.once(NatsEvent.OnReCnnect, ()=>{
                    this._send(payload, retryWhenReconnect);
                });
            } else {
                throw err;
            }
        }
    }

    protected _on_msg(subject: string, sid: string, payload: Class_Buffer, inbox: string) {
        let sop = this.subscriptions.get(sid);
        try {
            let data = payload.length > 0 ? this.decode(payload) : null;
            if (sop) {
                let meta: { subject: any, sid: string, reply?: (replyData: any) => void } = {
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
            } else if (inbox) {//队列选了当前执行节点，但是当前节点给取消订阅了
                this.publish(subject, payload, inbox);
            }
            this.emit(subject, data);
        } catch (e) {
            console.error("nats|on_msg", e);
        }
    }

    private _on_connect(connection:NatsConnection, isReconnected){
        this._connection = connection;
        connection.on("pong", this._on_pong.bind(this));
        connection.on("msg", this._on_msg.bind(this));
        connection.on("close", this._on_lost.bind(this));
        connection.on("ok", this._on_ok.bind(this));
        for(let e of this.subscriptions.values()){
            connection.send(Buffer.from(`SUB ${e.subject} ${e.sid}\r\n`));
        }
        coroutine.start(()=>{
            if(this._connection==connection){
                this.emit(NatsEvent.OnCnnect);
                if(isReconnected){
                    this.emit(NatsEvent.OnReCnnect);
                }
            }
        });
    }
    private _on_ok(err:boolean){
        if(err){

        }else{

        }
    }
    private _on_lost() {
        let last = this._connection;
        this.close();
        if (last!=null) {
            console.error("nats|on_lost => %s", JSON.stringify(last.address));
            this.emit(NatsEvent.OnLost);
            if(this._cfg.reconnect){
                this.reconnect();
            }
        }
    }

    protected _on_pong(is_lost: boolean) {
        if (is_lost) {
            let a = this._pingBacks;
            this._pingBacks = [];
            try {
                a.forEach(e=>e.suc(false));
            } catch (e) {
                console.error("nats|on_pong", e)
            }
        }else{
            let cb = this._pingBacks.shift();
            if(cb){
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


    //构建一个-并主动链接
    public static make(cfg?: string|NatsAddress|NatsConnectCfg) {
        let imp = new Nats();
        let conf:NatsConfig;
        if(typeof(cfg)=="string"){
            imp.addServer(cfg);
        }else if((<NatsConnectCfg_Mult>cfg).servers){
            (<NatsConnectCfg_Mult>cfg).servers.forEach(e=>{
                imp.addServer(e);
            });
            conf = {...DefaultConfig, ...cfg};
            delete conf["servers"];
        }else if(typeof((<NatsConnectCfg_One>cfg).url)!="string" || Object.values(cfg).some(e=>typeof(e)!="string")){
            imp.addServer((<NatsConnectCfg_One>cfg).url);
            conf = {...DefaultConfig, ...cfg};
            delete conf["url"];
        }else{
            imp.addServer(<NatsAddress>cfg);
        }
        imp._cfg = conf || {...DefaultConfig};
        if(imp._cfg.serizalize==null){
            if(imp._cfg["json"]){
                conf.serizalize = NatsSerizalize_Json;
            }else if(imp._cfg["msgpack"]){
                conf.serizalize = NatsSerizalize_Msgpack;
            }else{
                imp._cfg.serizalize = NatsSerizalize_Buf;
            }
        }
        return imp._do_connect(false);
    }
}

export const NatsEvent=Object.freeze({
    OnCnnect:"connect",
    OnIoError:"error",
    OnLost:"lost",
    OnReconnectFail:"on_reconnect_fail",
    OnReCnnect:"reconnect"
});

//侦听器-回调
type SubFn = (data: any, meta?: { subject: any, sid: string, reply?: (replyData: any) => void }) => void;
//侦听器-结构描述
type SubInfo = { subject: string, sid: string, fn: SubFn, num: number, t?: Class_Timer};

//{"server_id":"NDKOPUBNP4IRWW2UGWBNJ2VNNCWNBO3BTJXBDJ7JIA77ZVENDQF6U7QC","version":"2.0.4","proto":1,"git_commit":"c8ca58e","go":"go1.12.8","host":"0.0.0.0","port":4222,"max_payload":1048576,"client_id":20}
/**
 * 服务器信息描述
 */
export interface NatsServerInfo {
    server_id: string;
    version: string;
    go: string;
    max_payload: number;
    client_id: number;
    host: string;
    port: number;
}
/**
 * 服务器地址配置
 */
export interface NatsAddress {
    url?:string
    //授权user
    user?:string,
    //授权pass
    pass?:string,
    //授权token
    token?:string,
}
export interface NatsConfig {
    //socket链接超时时间ms
    timeout?:number,
    //计时进行ping服务器
    pingInterval?:number,
    maxPingOut?:number,
    //是否开启重连，默认true
    reconnect?:boolean,
    //重连暂停时间
    reconnectWait?:number,
    //是否禁用-重连时间随机
    noRandomize?:boolean,
    //重连最大次数
    maxReconnectAttempts?:number,

    //name=客户端连接名字,
    name?:string,
    //是否关闭连接自己发出去的消息-回显订阅
    noEcho?:boolean,

    //序列化方式
    serizalize?:NatsSerizalize,
    json?:boolean,
    msgpack?:boolean
}
type NatsConnectCfg_Mult = NatsConfig&{servers?:Array<string|NatsAddress>};
type NatsConnectCfg_One = NatsConfig&{url?:string|NatsAddress};
type NatsConnectCfg = NatsConnectCfg_Mult | NatsConnectCfg_One;

export type NatsSerizalize = {encode:(payload: any)=> Class_Buffer, decode:(buf:Class_Buffer)=>any};
export const NatsSerizalize_Json:NatsSerizalize = Object.freeze({encode:(payload:any)=>Buffer.from(JSON.stringify(payload)), decode:(buf:Class_Buffer)=>JSON.parse(buf.toString())});
export const NatsSerizalize_Msgpack:NatsSerizalize = Object.freeze({encode:(payload:any)=>msgpack.encode(payload), decode:(buf:Class_Buffer)=>msgpack.decode(buf)});
export const NatsSerizalize_Str:NatsSerizalize = Object.freeze({encode:(payload:any)=>Buffer.isBuffer(payload)?payload:Buffer.from(String(payload)), decode:(buf:Class_Buffer)=>buf.toString()});
export const NatsSerizalize_Buf:NatsSerizalize = Object.freeze({encode:(payload:any)=>Buffer.isBuffer(payload)?payload:Buffer.from(String(payload)), decode:(buf:Class_Buffer)=>buf});

const DefaultAddress:NatsAddress = {url:"nats://localhost:4222"};
const DefaultConfig:NatsConfig = {timeout:3000, reconnect:true, reconnectWait:250, maxReconnectAttempts:86400, name:"fibjs-nats", noEcho:true, maxPingOut:9};

abstract class NatsConnection extends EventEmitter{
    protected _state:number;
    protected _pingTimer:Class_Timer;
    protected _pingIng:number;
    constructor(protected _cfg:NatsConfig, protected _addr:NatsAddress, protected _info:NatsServerInfo) {
        super();
        if(this._cfg.pingInterval>0 && this._cfg.maxPingOut>0){
            this._pingIng = 0;
            this._do_ping();
        }
    }
    private _do_ping(){
        if(this._pingIng>this._cfg.maxPingOut){
            if(this._state==1){
                this._on_lost("maxPingOut");
            }
            return;
        }
        this._pingIng++;
        this._pingTimer = setTimeout(this._do_ping.bind(this), this._cfg.pingInterval);
        this.once("pong", ()=>{
            this._pingIng=0;
            clearTimeout(this._pingTimer);
        });
        try{
            this.send(B_PING_EOL);
        }catch (e) {
            clearTimeout(this._pingTimer);
        }
    }
    public get address():NatsAddress{
        return this._addr;
    }
    public get info():NatsServerInfo{
        return this._info;
    }
    protected fire(evt:string, ...args){
        coroutine.start(()=>{
            try{
                this.emit(evt, ...args);
            }catch (e) {
                console.error("process_nats:"+evt,e);
            }
        });
    }
    abstract send(payload:Class_Buffer):void;

    protected _fn_close(){

    }

    protected _on_lost(reason:string=""){
        if(this._state==1){
            this._state = 3;
            try{
                this._fn_close();
            }catch (e) {
            }
            this.emit("close", {type:"close",code:888,reason:reason});
        }
    }
    public close(){
        this._on_lost("close");
        this.eventNames().forEach(e=>{
            this.off(e);
        })
    }
}
class NatsSocket extends NatsConnection{
    private _lock:Class_Lock;
    private _reader:Class_Fiber;
    constructor(private _sock:Class_Socket, private _stream:Class_BufferedStream, _cfg:NatsConfig, _addr:NatsAddress, _info:NatsServerInfo) {
        super(_cfg, _addr, _info);
        _sock.timeout = 0;
        this._lock = new coroutine.Lock();
        this._state = 1;
        this._reader = coroutine.start(this._read.bind(this));
    }
    private _read(){
        let stream = this._stream;
        let is_fail = (s:Class_Buffer|string)=>s===null;
        while(this._state==1){
            try {
                let line = stream.readLine();
                if (is_fail(line)) {
                    // console.log("read_fail:0",line,data);
                    break;
                }
                let c1 = line.charAt(1);
                if(c1==CHAR_1_MSG){
                    //MSG subject sid size
                    let arr = line.split(" "),
                        subject:string = arr[1],
                        sid:string = arr[2],
                        inbox:string,
                        len:number,
                        data = EMPTY_BUF;
                    if(arr.length>4){
                        inbox = arr[3];
                        len = Number(arr[4]);
                    }else{
                        len = Number(arr[3]);
                    }
                    // console.log(line, len);
                    if (len>0) {
                        data = stream.read(len);
                        // console.log(data, String(data))
                        if (is_fail(data)) {
                            // console.log("read_fail:1",line,data);
                            break;
                        }
                    }
                    stream.read(2);
                    this.fire("msg",subject, sid, data,inbox);
                }else if(c1==CHAR_1_OK){
                    this.fire("ok");
                }else if(c1==CHAR_1_PING){
                    this.send(B_PONG_EOL);
                }else if(c1==CHAR_1_PONG){
                    this.fire("pong");
                }else if(c1==CHAR_1_ERR){
                    let tmp = line.split(" ");
                    this.fire("err", {type:tmp[0],reason:tmp[1]});
                }
            } catch (e) {
                console.error("nats|reading", e);
                this._on_lost(e.message);
                break;
            }
        }
        this._on_lost("read_lost");
    }
    public send(payload:Class_Buffer) {
        try {
            this._lock.acquire();
            this._sock.send(payload);
            this._lock.release();
        } catch (e) {
            this._lock.release();
            this._on_lost(e.message);
            throw e;
        }
    }
    protected _fn_close(){
        this._sock.close();
    }

    public static connect(addr:NatsAddress, cfg:NatsConfig):NatsConnection{
        let sock = new net.Socket(net.AF_INET), stream: Class_BufferedStream;
        let url_obj = parse(addr.url);
        let fn_close = ()=>{
            try{
                sock.close();
            }catch (e) {
            }
        }
        try {
            if(cfg.timeout>0){
                sock.timeout = cfg.timeout;
            }
            sock.connect(url_obj.hostname, parseInt(url_obj.port)||4222);
            stream = new BufferedStream(sock);
            stream.EOL = "\r\n";
            let info = stream.readLine(512);
            if (info == null) {
                fn_close();
                throw new Error("closed_while_reading_info");
            }
            let opt: any = {
                verbose: false,
                pedantic: false,
                ssl_required: false,
                name: cfg.name,
                lang: LANG,
                version: VERSION,
                noEcho:cfg.noEcho,
            }
            if (addr.user && addr.pass) {
                opt.user = addr.user;
                opt.pass = addr.pass;
            } else if (addr.token) {
                opt.auth_token = addr.token;
            }
            sock.send(Buffer.from(`CONNECT ${JSON.stringify(opt)}\r\n`));
            sock.send(B_PING_EOL);
            if (stream.readLine(6) != null) {
                return new NatsSocket(sock, stream, cfg, addr, JSON.parse(info.toString().split(" ")[1]));
            } else {
                fn_close();
                throw new Error("auth_connect_fail");
            }
        } catch (e) {
            sock.close();
            console.error('Nats|open_fail', addr.url, e.message);
        }
        return null;
    }
}
class NatsWebsocket extends NatsConnection {
    constructor(private _sock:Class_WebSocket, _cfg:NatsConfig, _addr:NatsAddress, _info:NatsServerInfo) {
        super(_cfg, _addr, _info);
        this._state = 1;
        _sock.onclose = e=>{
            this._on_lost(e.reason);
        }
        _sock.onmessage = e=>{
            this.processMsg(<Class_Buffer>e.data)
        };
    }
    private _last:Class_Buffer;
    private processMsg(buf:Class_Buffer){
        if(this._last){
            this._last.append(buf);
            buf = this._last;
            this._last = null;
        }
        let idx:number,offset=0;
        while((idx=buf.indexOf(B_EOL,offset))>-1){
            if(idx==0){
                offset+=2;
                if(buf.length>offset){
                    continue;
                }
                return;
            }
            let line = buf.slice(0,idx), b1=line[1];
            if(b1==BIG_1_MSG){
                //MSG subject sid size
                let arr = line.toString().split(" "),
                    subject: string = arr[1],
                    sid: string = arr[2],
                    inbox: string,
                    len: number,
                    data = EMPTY_BUF;
                if (arr.length > 4) {
                    inbox = arr[3];
                    len = Number(arr[4]);
                } else {
                    len = Number(arr[3]);
                }
                if(buf.length<(idx+len+2)){
                    break;
                }
                data = buf.slice(idx+2,idx+2+len);
                buf = buf.slice(idx +len + 4);offset = 0;
                this.fire("msg", subject, sid, data, inbox);
            }else{
                buf = buf.slice(idx+2); offset = 0;
                if(b1==BIT_1_OK){// +OK
                    this.fire("ok");
                }else if(b1==BIT_1_PING){//PING
                    this.send(B_PONG_EOL);
                }else if(b1==BIT_1_PONG){//PONG
                    this.fire("pong");
                }else if(b1==BIT_1_ERR){// -ERR
                    let tmp = line.toString().split(" ");
                    this.fire("err", {type:tmp[0],reason:tmp[1]});
                }
            }
        }
        if(buf.length>offset){
            this._last = buf.slice(offset);
        }
    }
    public send(payload:Class_Buffer) {
        try {
            this._sock.send(payload);
        } catch (e) {
            this._on_lost(e.message);
            throw e;
        }
    }
    protected _fn_close(){
        this._sock.close();
    }

    public static connect(addr:NatsAddress, cfg:NatsConfig):NatsConnection{
        if(addr.url.startsWith("wss")){
            ssl.loadRootCerts();
            // @ts-ignore
            ssl.verification = ssl.VERIFY_NONE;
        }
        let sock = new ws.Socket(addr.url, {perMessageDeflate:false});
        let svr_info:any;
        let open_evt = new coroutine.Event();
        let err_info:string = null;
        sock.once("open",e=>{
            sock.off("error");
            open_evt.set();
            sock.once("message", e=>{
                svr_info = JSON.parse(e.data.toString().replace("INFO ","").trim());
                open_evt.set();
            });
            sock.once("close",e=>{
                err_info = "closed_while_reading_info";
                open_evt.set();
            });
        });
        sock.once("error",e=>{
            err_info = e&&e.reason?e.reason:"io_error";
            open_evt.set();
        });
        open_evt.wait();
        if (!err_info) {
            if(!svr_info){
                open_evt.clear();
                open_evt.wait();
            }
        }
        if(!svr_info){
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
class WaitEvt<T> extends coroutine.Event{
    public rsp:T;
    public err:Error|string;
    public suc(v:T){
        this.rsp = v;
        this.set();
    }
    public fail(e:Error|string){
        this.err = e;
        this.set();
    }
}

function convertToAddress(uri:string) {
    let obj = parse(uri);
    let itf: NatsAddress = {...DefaultAddress,url:String(uri)};
    if(obj.query){
        let query = queryString.parse(obj.query);
        if(query.first("user") && query.first("pass")){
            itf.user = query.first("user");
            itf.pass = query.first("pass");
        }
        if(query.first("token")){
            itf.token = query.first("token");
        }
    }
    if(!itf.token && obj.auth && !obj.password){
        itf.token = obj.auth;
    }else if(!itf.user && obj.username && obj.password){
        itf.user = obj.username;
        itf.pass = obj.password;
    }
    let auth_str = "";
    if(itf.token){
        auth_str = itf.token+"@";
    }else if(itf.user){
        auth_str = itf.user+":"+itf.pass+"@";
    }
    itf.url = obj.protocol+"//"+auth_str+obj.hostname+":"+(parseInt(obj.port)||4222);
    return itf;
}

const EMPTY_BUF = new Buffer([]);
const B_SPACE = Buffer.from(" ");
const B_EOL = Buffer.from("\r\n");
const B_PUB = Buffer.from("PUB ");
const B_PUBLISH_EMPTY = Buffer.from(" 0\r\n\r\n");
const B_PING_EOL = Buffer.from("PING\r\n");
const B_PONG_EOL = Buffer.from("PONG\r\n");
const S_EOL = "\r\n";

const CHAR_1_ERR = "E";
const CHAR_1_OK = "O";
const CHAR_1_PING = "I";
const CHAR_1_PONG = "O";
const CHAR_1_MSG = "S";
const BIT_1_ERR:number = Buffer.from(CHAR_1_ERR)[0];
const BIT_1_OK:number = Buffer.from(CHAR_1_OK)[0];
const BIT_1_PING:number = Buffer.from(CHAR_1_PING)[0];
const BIT_1_PONG:number = Buffer.from(CHAR_1_PONG)[0];
const BIG_1_MSG:number = Buffer.from(CHAR_1_MSG)[0];