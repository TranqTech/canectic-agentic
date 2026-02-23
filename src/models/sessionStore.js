import * as bcrypt from 'bcrypt';
const saltRounds = 10;
import { v4 as uuidv4 } from 'uuid';
import { createClient } from 'redis';
import * as dotenv from 'dotenv';

//variable setup
// redis expirations are in seconds. Setting a default of 3600 is one hour
// 86400 would be one day. 604800 one week. 2592000 One Month(30 days)
const defaultexpire = 3600
var expiretime = defaultexpire

const redisClient = createClient();

async function setExpireTime(){
	if (process.env.sessionexpire){
		expiretime = await Number(process.env.sessionexpire)
	}
}

async function getSession(sessionid){
	if (sessionid != null){
		try{
			var rsessionid = "session-" + sessionid
			await redisClient.connect();
			var sessionvalid = await redisClient.exists(rsessionid);
			if (!sessionvalid){
				return null
			}
			var container = {}
			//do container fill from redis object
			container['id'] = await redisClient.hGet(rsessionid, "id");
			container['username'] = await redisClient.hGet(rsessionid, "username");
			container['realname'] = await redisClient.hGet(rsessionid, "realname");
			container['fullname'] = await redisClient.hGet(rsessionid, "fullname");
			container['security'] = await redisClient.hGet(rsessionid, "security");
			container['isSysop'] = await redisClient.hGet(rsessionid, "isSysop");
			container['tziana'] = await redisClient.hGet(rsessionid, 'tziana');
			container['tzname'] = await redisClient.hGet(rsessionid, 'tzname');
			container['tzoffsetmins'] = await redisClient.hGet(rsessionid, 'tzoffsetmins');
			container['flaglist'] = await redisClient.hGet(rsessionid, 'flaglist');
			container['restrictionlist'] = await redisClient.hGet(rsessionid, 'restrictionlist');
			await redisClient.quit()
			if (container['isSysop'] == "true"){
				container['isSysop'] = true
			}else{
				container['isSysop'] = false
			}
			container.flags = []
			container.restrictions = []
			if (container.flaglist){
				container.flags = container.flaglist.split(",")
			}
			if (container.restrictionlist){
				container.restrictions = container.restrictionlist.split(",")
			}
			return container;
		}catch(error){
			console.log(error)
			return null
		}
	}else{
		return null
	}
}

async function storeSession(sessionid, userrecord){
	//
}

async function destroySession(sessionid){
	var rsessionid = "session-" + sessionid  
	await redisClient.connect();
	await redisClient.DEL(rsessionid);
	await redisClient.quit();
}

async function checkForSession(sessionid){
	if (sessionid != null){
		var rsessionid = "session-" + sessionid
		await redisClient.connect();
		var sessionvalid = await redisClient.exists(rsessionid);
		await redisClient.quit();
		return sessionvalid;		
	}else{
		return false;
	}

}


async function renewSession(sessionid){
	await setExpireTime()
	try{
		if (sessionid != null){
		var rsessionid = "session-" + sessionid
		await redisClient.connect();
		await redisClient.EXPIRE(rsessionid, expiretime)
		await redisClient.quit();		
		}
	}catch(error){
		console.log(error)
	}	
}

async function listSessions(){
	await redisClient.connect();
	var scanpattern = "session-*"
	//var responder = await redisClient.scan(0, 'MATCH', scanpattern)
	var responder = await redisClient.keys(scanpattern);
	await redisClient.quit();
	return responder;
}


export{
	getSession,
	storeSession,
	destroySession,
	checkForSession,
	renewSession,
	listSessions
}