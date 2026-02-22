//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { DateTime } from "luxon";

//internal modules
import * as postgres from '../middleware/db/postgres.js'

//setup
const defaultsecurity = process.env.defaultsecurity || 50
const saltRounds = 10;
const requiredfields = []
//This is here as a dev and testing debug. 
//Passwords should NEVER be stored plaintext in production
const storeplain = process.env.storeplainindev_yesimsure

async function checkUserPass(username, password){
	var dbuser = await getUserRecord(username)
	if (dbuser){
		console.log("Record Found!")
	}else{
		console.log("Record NOT Found")
	}
	var result = {
		isvalid: true
	}
	result.useraccount = {
		username: "TestUser",
		fullname: "Some Dude",
		location: "Unknown"
	}
	return result
	//
}

async function updateUserCalls(){
	
}

async function checkNetmailUnique(){
	//
}

async function checkUsernameAvailable(){
	//
}

async function getUserRecord(pusername){
	var dbres = await postgres.singlereadquery("SELECT * FROM users WHERE LOWER(username) LIKE LOWER('$1')", [pusername.trim()])
	return dbres
}

async function createNewUser(){
	//
}

async function getUserList(){
	//
}

async function updateUserMsgGroup(){
	//
}

async function updateUserMsgArea(){
	//
}

export{checkUserPass, updateUserCalls, checkNetmailUnique, checkUsernameAvailable, getUserRecord, createNewUser, getUserList, updateUserMsgGroup, updateUserMsgArea}