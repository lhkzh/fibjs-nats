# fibjs-nats
nats-client nats客户端实现  

 * 协议参考（暂不支持ssl&auth,msgpack需要fibjsv0.30+）
 * https://www.cnblogs.com/liang1101/p/6641348.html
 * https://github.com/repejota/phpnats
 * https://github.com/lhkzh/fibjs-nats  
 
 使用  
 const NatsJson = require("fibjs-nats").NatsJson;  
 let nc = new NatsJson();  
 nc.server(["nats://127.0.0.1:4222"]);  
 nc.connect();  
 
 nc.subscribe("svr.sum",function (data,meta) {  
     meta.reply(data.a+data.b);  
 });  
 
 var total=5000,now=0,startTm=Date.now();  
rcImp(total);  
 function rcImp(n) {  
     for(var i=0;i<n;i++){  
         nc.requestSync("svr.sum",{a:1,b:Date.now()})  
         now++;  
         if(now%500==0){  
             console.log(now,now/total)  
         }  
         if(now>=total){  
             console.log(Date.now()-startTm, (Date.now()-startTm)/total)  
         }  
     }  
 }  
 
 