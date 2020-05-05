/// <reference types="@fibjs/types" />
/**
 * nats客户端实现
 * 协议参考
 * https://www.cnblogs.com/liang1101/p/6641348.html
 * https://github.com/repejota/phpnats
 */
// const OPTIONS={"verbose":false,"pedantic":false,"ssl_required":false,"name":"","lang":"fibjs","version":"1.0.0"};
import util = require('util');
import events = require('events');
import net = require('net');
import io = require('io');
import coroutine = require('coroutine');
import URL = require("url");
import nuid = require("./Nuid");

export class Index extends events.EventEmitter{
    private subscriptions:{[index:string]:{subject:string, sid:string, fn:Function, num:number, t?:Class_Timer}}={}
    private address_list:Array<NatsAddress>;
    private default_server:NatsAddress={host:"127.0.0.1", port:4222};
    private sock:Class_Socket;
    private stream:Class_BufferedStream;
    private info:NatsServerInfo;
    private autoReconnect:boolean;
    private re_connet_ing:boolean;
    private requestTimeout:number=10000;
    private pingBacks:Array<(suc:boolean)=>void>=[];
    constructor() {
        super();
    }
    public getInfo(){
        return this.info;
    }
    private toAddr(addr:string){
        var info=URL.parse(addr);
        var itf:NatsAddress = {host:info.host.length>0?info.host:info.hostname, port:info.port.length>0?parseInt(info.port):4222};
        if(info.username.length>0){
            itf.user=info.username;
            itf.pass=info.password;
        }
        return itf;
    }
    public addServer(addr:string){
        var itf=this.toAddr(addr);
        var target=JSON.stringify(itf);
        var had=this.address_list.some(e=>{
            return JSON.stringify(e)==target;
        });
        if(had){
            return;
        }
        this.address_list.push(itf);
        return this;
    }
    public removeServer(addr:string){
        var itf=this.toAddr(addr);
        var target=JSON.stringify(itf);
        this.address_list=this.address_list.filter(e=>{
            return JSON.stringify(e)!=target;
        });
        return true;
    }
    /**
     * 配置连接地址
     * @param addr  ["nats://127.0.0.1:4222", "nats://zhh:pwd@127.0.0.1:4223"]
     */
    public server(addr:Array<string>|string){
        // this.address_list= util.isArray(addr)?<Array<NatsAddress>>addr:[<NatsAddress>addr];
        this.address_list=[];
        var arr=util.isArray(addr)?<Array<string>>addr:[String(addr)];
        arr.forEach(e=>{
            this.address_list.push(this.toAddr(e));
        });
        return this;
    }
    //重连
    public reconnect(){
        if(this.re_connet_ing)return;
        try{
            this.re_connet_ing=true;
            this.connect(8181,50,this.autoReconnect);
        }finally {
            this.re_connet_ing=false;
        }
    }
    /**
     * 建立连接
     * @param retryNum
     * @param retryDelay
     * @param autoReconnect
     */
    public connect(retryNum:number=3,retryDelay:number=60,autoReconnect:boolean=true){
        var last=this.sock;
        if(last!=null){
            try{
                last.close();
            }catch (e) {
            }
            this.sock=null;
            this.stream=null;
            this.info=null;
        }
        this.autoReconnect=autoReconnect;
        var tmps=this.address_list&&this.address_list.length>0?this.address_list.slice(0):[this.default_server];
        tmps=shuffle(tmps);
        M:for(var i=0;i<Math.max(1,retryNum);i++){
            for(var j=0;j<tmps.length;j++){
                var node=tmps[j];
                try{
                    var sock=new net.Socket();
                    sock.connect(node.host, node.port);
                    var stream=new io.BufferedStream(sock);
                    stream.EOL="\r\n";
                    var info=stream.readLine(360);
                    if(info==null){
                        continue;
                    }
                    var conn:string;
                    if(node.user&&node.pass){
                        conn=`CONNECT {"user":"${node.user}","pass":"${node.pass}","verbose":false,"pedantic":false,"ssl_required":false,"name":"","lang":"fibjs","version":"1.0.0"}\r\n`
                    }else{
                        conn=`CONNECT {"verbose":false,"pedantic":false,"ssl_required":false,"name":"","lang":"fibjs","version":"1.0.0"}\r\n`;
                    }
                    sock.send(Buffer.from(conn));
                    sock.send(B_PING_EOL);
                    var rsp=stream.readLine(8);
                    if ( rsp!= null) {
                        this.sock = sock;
                        this.stream = stream;
                        this.info = JSON.parse(info.toString().split(" ")[1]);
                        break M;
                    }
                }catch (e) {
                }
            }
            if(retryDelay>0){
                coroutine.sleep(retryDelay);
            }
        }
        if(this.sock==null){
            this.emit("error","connect_nats_fail");
            var err=new Error("connect_nats_fail");
            console.log("nats|connect",err.message)
            throw err;
        }
        coroutine.start(this.read2pass.bind(this));
    }
    public ping(){
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
        if(!this.sock){
            return false;
        }
        try{
            this.send(B_PING_EOL);
            var evt=new coroutine.Event(false);
            var ret:boolean;
            this.pingBacks.push(suc=>{
                ret=suc;
                evt.set();
            });
            evt.wait();
            return ret;
        }catch (e) {
            return false;
        }
    }
    /**
     * 请求接口
     * @param subject
     * @param payload
     */
    public request(subject:string, payload:any):Promise<any>{
        var sid, subs=this.subscriptions, timeout;
        return new Promise<any>((resolve, reject)=>{
            try{
                var inbox = '_INBOX.'+nuid.next();
                sid=this.subscribe(inbox, function(d){
                    resolve(d);
                }, 1);
                var part=subs[sid];
                timeout = part.t=setTimeout(function(){
                    delete subs[sid];
                    reject(new Error("nats_req_timeout_"+subject));
                },this.requestTimeout);
                this.publish(subject, payload, inbox);
            }catch (e) {
                if(sid){
                    delete subs[sid];
                    if(timeout){
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
    public requestSync(subject:string, payload:any):any{
        var sid,
            subs=this.subscriptions,
            rsp,
            inbox = '_INBOX.'+nuid.next(),
            isTimeouted, timeout:Class_Timer,
            evt=new coroutine.Event(false);

        try{
            sid=this.subscribe(inbox, function(d){
                rsp=d;
                evt.set();
            }, 1);
            timeout = subs[sid].t=setTimeout(function(){
                isTimeouted=true;
                evt.set();
            },this.requestTimeout);
            this.publish(subject, payload, inbox);
        }catch (e) {
            if(sid){
                delete subs[sid];
                if(timeout){
                    clearTimeout(timeout);
                }
            }
            throw e;
        }
        evt.wait();
        delete subs[sid];
        clearTimeout(timeout);
        if(isTimeouted){
            throw new Error("nats_req_timeout_"+subject);
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
    public queueSubscribe(subject:string, queue:string, callBack:(d:any)=>void, limit?:number):string{
        return this.subscribe(subject+' '+queue, callBack, limit);
    }
    /**
     * 订阅
     * @param subject
     * @param callBack
     * @param limit
     */
    public subscribe(subject:string, callBack:(err,d:any)=>void, limit?:number):string{
        var sid = nuid.next();
        this.subscriptions[sid]={
            subject:subject,
            sid:sid,
            fn:callBack,
            num:limit>0?limit:-1
        };
        this.send(Buffer.from('SUB '+subject+' '+sid+'\r\n'));
        return sid;
    }
    /**
     * 取消订阅
     */
    public unsubscribe(sid:string, quantity?:number){
        var msg = 'UNSUB '+sid+(arguments.length>1 ? ' '+quantity:'')+'\r\n';
        if(arguments.length<2){
            delete this.subscriptions[sid];
        }
        this.send(Buffer.from(msg));
    }
    //取消所有主题-订阅
    public unsubscribeSubject(subject:string){
        Object.values(this.subscriptions).forEach(e=>{
            if(e.subject==subject){
                this.unsubscribe(e.sid);
            }
        });
    }
    //取消所有订阅
    public unsubscribeAll(){
        var vals=Object.values(this.subscriptions);
        this.subscriptions={};
        if(!this.sock){
            return;
        }
        vals.forEach(e=>{
            try{
                this.unsubscribe(e.sid);
            }catch (e) {
            }
        });
    }
    public close(){
        var last=this.autoReconnect;
        if(this.sock){
            this.sock.close();
        }
        coroutine.sleep(10);
        this.autoReconnect=last;
    }
    //发布数据
    public publish(subject:string, payload?:any, inbox?:string){
        var arr:Array<any>=[B_PUB, Buffer.from(subject)];
        if(inbox){
            arr.push(B_SPACE,Buffer.from(inbox));
        }
        if(payload!=null){
            var pb:Class_Buffer = this.encode(payload);
            arr.push(Buffer.from(" "+pb.length+"\r\n"), pb, B_EOL);
        }else{
            arr.push(B_PUBLISH_EMPTY)
        }
        this.send(Buffer.concat(arr));
    }
    protected send(payload){
        try{
            this.sock.send(payload);
        }catch (e) {
            this.on_lost();
            if(this.autoReconnect){
                this.sock.send(payload);
            }else{
                throw e;
            }
        }
    }
    protected process(subject:string, sid:string, payload:Class_Buffer, inbox:string){
        var sop=this.subscriptions[sid];
        try{
            var data=payload.length>0 ? this.decode(payload):null;
            if(sop){
                var meta:any={subject:subject, sid:sid};
                if(inbox){
                    meta.reply=(replyData)=>{
                        this.publish(inbox, replyData);
                    };
                }
                if(sop.num>1){
                    sop.num--;
                    if(sop.num==0){
                        delete this.subscriptions[sid];
                        if(sop.t){
                            clearTimeout(sop.t);
                        }
                    }
                }
                sop.fn(data, meta);
            }
            this.emit(subject, data);
        }catch (e) {
            console.error("nats|process",e);
        }
    }
    private read2pass(){
        var sock=this.sock;
        var stream=this.stream;
        var processMsg=this.process.bind(this);
        var processPong=this.process_pong.bind(this);
        var subVals=Object.values(this.subscriptions);
        if(subVals.length>0){
            try{
                subVals.forEach(e=>{
                    this.send(Buffer.from('SUB '+e.subject+' '+e.sid+'\r\n'));
                });
            }catch (e) {
            }
        }
        while(sock==this.sock){
            try{
                var line=stream.readLine();
                if(this.is_read_fail(line)){
                    // console.log("read_fail:0",line,data);
                    break;
                }
                if(line==S_PING){
                    this.send(B_PONG_EOL);
                    continue;
                }else if(line==S_PONG){
                    coroutine.start(processPong, true);
                    continue;
                }else if(line==S_OK){
                    continue;
                }
                //MSG subject sid size
                var arr=line.split(" ");
                var subject=arr[1];
                var sid=arr[2];
                var inbox=arr.length>4?arr[3]:null;
                var len=arr.length>4?Number(arr[4]):Number(arr[3]);
                // console.log(line, len);
                if(len==0){
                    coroutine.start(processMsg, subject, sid, EMPTY_BUF, inbox);
                    continue;
                }
                var data=stream.read(len);
                // console.log(data, String(data))
                if(this.is_read_fail(data)){
                    // console.log("read_fail:1",line,data);
                    break;
                }
                stream.read(2);
                coroutine.start(processMsg, subject, sid, data, inbox);
            }catch (e) {
                console.error("nats|read2pass",e);
            }
        }
    }
    private is_read_fail(d){
        if(d==null){
            this.on_lost();
            return true;
        }
        return false;
    }
    private on_lost(){
        if(this.sock!=null){
            try{
                this.sock.close();
            }catch (e) {
            }
        }
        this.sock=null;
        console.error("nats|on_lost => %s",(this.info.host+":"+this.info.port));
        this.emit("lost");
        if(this.autoReconnect){
            coroutine.start(this.reconnect.bind(this));
        }
        this.process_pong(false);
    }
    protected process_pong(ret:boolean){
        if(this.pingBacks.length>0){
            var a=this.pingBacks.concat();
            this.pingBacks.length=0;
            try{
                a.forEach(f=>{
                    f(ret);
                });
            }catch (e) {
                console.error("nats|process_pong",e)
            }
        }
    }
    protected encode(payload:any):Class_Buffer{
        if(util.isBuffer(payload)){
            return payload;
        }
        return Buffer.from(String(payload));
    }
    protected decode(data:Class_Buffer):any{
        return data;
    }
}

export class NatsJson extends Index{
    protected encode(payload:any):Class_Buffer{
        var k:number;
        var pb:Class_Buffer;
        if(util.isBuffer(payload)){
            pb = <Class_Buffer>payload;
            pb.writeUInt16BE(0);
        }else{
            pb = Buffer.from(JSON.stringify(payload));
        }
        pb.writeUInt16BE(k);
        return pb;
    }
    protected decode(data:Class_Buffer):any{
        if(data.readInt16BE(data.length-1)==0){
            return data.slice(0, data.length-2);
        }
        return JSON.parse(data.toString());
    }
}
export class NatsMsgpack extends Index{
    protected encode(payload:any):Class_Buffer{
        return require('msgpack').encode(payload);
    }
    protected decode(data:Class_Buffer):any{
        try{
            return require('msgpack').decode(data);
        }catch (e) {
            console.error("nats|msgpack_decode_err",e.message);
            return data.toString();
        }
    }
}
const EMPTY_BUF=new Buffer([]);
const B_SPACE=Buffer.from(" ");
const B_EOL=Buffer.from("\r\n");
const B_PUB=Buffer.from("PUB ");
const B_PUBLISH_EMPTY=Buffer.from(" 0\r\n\r\n");
const B_PING=Buffer.from("PING");
const B_PING_EOL=Buffer.from("PING\r\n");
const B_PONG=Buffer.from("PONG");
const B_PONG_EOL=Buffer.from("PONG\r\n");
const B_OK=Buffer.from("+OK");
const B_ERR=Buffer.from("-ERR");

const S_PING="PING";
const S_PING_EOL=Buffer.from("PING\r\n");
const S_PONG="PONG";
const S_PONG_EOL="PONG\r\n";
const S_OK="+OK";

//{"server_id":"NDKOPUBNP4IRWW2UGWBNJ2VNNCWNBO3BTJXBDJ7JIA77ZVENDQF6U7QC","version":"2.0.4","proto":1,"git_commit":"c8ca58e","go":"go1.12.8","host":"0.0.0.0","port":4222,"max_payload":1048576,"cli
// ent_id":20}
export interface NatsServerInfo {
    server_id:string;
    version:string;
    go:string;
    max_payload:number;
    client_id:number;
    host:string;
    port:number;
}
export interface NatsAddress {
    host:string;
    port:number;
    user?:string;
    pass?:string;
}
/**
 * @hidden
 */
function shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}