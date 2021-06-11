# fibjs-nats
nats-client 针对fibjs的nats客户端实现  

 * 暂不支持jwt&wss&nkey    
 * msgpack需要fibjsv0.30+    
 * sub/unsub当前实现先处理本地后send未确认ok    
 * bug->https://github.com/lhkzh/fibjs-nats   
 * fibjs->https://fibjs.org    
 使用  
<pre>
<code>
 const Nats = require("fibjs-nats").Nats;  
 //无授权认证方式
 var nc = Nats.make({json:true,url:"nats://127.0.0.1:4222"});    
 //tls认证方式
 var nc = Nats.make({json:true,url:"nats://127.0.0.1:4222",ssl:{cert:"/nats/certs/client.pem",key:crt:"/nats/certs/client-key.pem"}});  
 //通过-username:password认证
 var nc_auth_userpassword = Nats.make({json:true,url:"nats://myusername:mypassword@127.0.0.1:4222"});  
 //通过-authtoken认证
 var nc_auth_token = Nats.make({json:true,url:"nats://mytoken@127.0.0.1:4222"});  
 //通过websockt接入  
 var nc_by_ws = Nats.make({json:true,url:"ws://127.0.0.1:8022"});    
 //多cluster接入    
 var nc = Nats.make({json:true,servers:["nats://127.0.0.1:4222","nats://127.0.0.1:4223","ws://127.0.0.1:8022"]});     
  
 //订阅主题 
 var sub = nc.subscribe("svr.sum",function (data,meta) {  
     meta.reply(data.a+data.b);  //响应消息
 });      
 console.log(nc.request("svr.sum",{a:2,b:3})==5);      
 //取消订阅
 sub.cancel();    
 nc.unsubscribe(sub);    
 nc.unsubscribe(sub.sid);    
 nc.unsubscribeSubject("svr.sum");    
 //取消所有订阅
 uc.unsubscribeAll();    
 
 nc.subscribe("svr.log",function (data,meta) {  
     console.log("svr.log",data);
 });  
 //发布消息
 nc.publish("svr.log", "on xxx");    
 //ping
 console.log(nc.ping());    
 //释放连接
 nc.close();
</code>
</pre> 

 
 