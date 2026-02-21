//import { Pool } from "pg";
//import { Pool, Client } from 'pg';
//const { Pool } = pg;
import pkg from 'pg';
const { Pool } = pkg;
import * as dotenv from 'dotenv';

dotenv.config()


const dbuser = process.env.dbuser || "canectic"
const dbhost = process.env.dbhost || "localhost"
const dbname = process.env.dbname || "canectic_bbs"
const dbpass = process.env.dbpass;
const dbport = process.env.dbport || 5432

const pgpool = new Pool({
  user: dbuser,
  host: dbhost,
  database: dbname,
  password: dbpass,
  port: dbport,
})

async function readquery(text, params){
  try{
    var {rows} = await pgpool.query(text, params)
  }catch(error){
    console.log(error);
  }
  if(rows){
    return rows;
  }else{
    return null;
  }
}

async function singlereadquery(text, params){
  try{
    var {rows} = await pgpool.query(text, params)
  }catch(error){
    console.log(error);
  }
  if(rows){
    return rows[0];
  }else{
    return null;
  }
}

async function writequery(text, params){
  try{
    await pgpool.query(text, params)
  }catch(error){
    console.log(error)
  }
}

async function checkedwritequery(text, params){
  try{
    await pgpool.query(text, params)
    return null;
  }catch(error){
    console.log(error)
    return error;
  }
}

async function query(text, params){
  try{
    var {rows} = await pgpool.query(text, params)
    if(rows){
      //console.log("Got a result")
      //console.log(rows)
      return rows
    }else{
      console.log("No result")
      return null;
    }
  }catch(error){
    console.log(error)
    return null;
  }  
}

async function updateParamsById(objectId, params, tablename){
  var paramlist = Object.keys(params)
  var updatevalues = [objectId]
  var paramcount = paramlist.length
  var updatetext = 'WITH rows AS (UPDATE ' + tablename + " SET "
  var i = 2
  for await (var parm of paramlist){
    if (i > 2){
      updatetext += ", "
    }
    updatetext += parm + "=$" + i
    updatevalues.push(params[`${parm}`])
    i++
  }
  updatetext += " WHERE id=$1 RETURNING 1) SELECT count(*) FROM rows"
  try{
    var dbres = await query(updatetext, updatevalues)
    console.log(dbres)
    if ((dbres)&&(dbres[0])){
      if (dbres[0].count){
        return dbres[0].count
      }else{
        return 0
      }
    }else{
      return 0
    }
  }catch(error){
    console.log(error)
    return 0
  }
}

async function insertByParams(params, tablename){
  var paramlist = Object.keys(params)
  var insertvalues = []
  var paramcount = paramlist.length
  var inserttext = 'INSERT INTO ' + tablename + " ("
  var itext2 = ") VALUES("
  var i = 1
  for await (var parm of paramlist){
    if (i>1){
      inserttext += ", "
      itext2 += ", "
    }
    inserttext += parm
    itext2 += "$"
    itext2 += i
    insertvalues.push(params[`${parm}`])
    i++
  }
  inserttext += itext2
  inserttext += ") RETURNING id"
  console.log("Final Query:", inserttext)
  try{
    var dbres = await query(inserttext, insertvalues)
    if ((dbres)&&(dbres[0])){
      return dbres[0]
    }else{
      return null
    }
  }catch(error){
    console.log(error)
    return null
  }
  
}

async function insertObject(insertObj, tablename){
  var retObj = {
    status: false,
    result: "",
    insertId: "",
    errormessages: []
  }
  var paramlist = Object.keys(insertObj)
  var insertvalues = []
  var paramcount = paramlist.length
  var inserttext = 'INSERT INTO ' + tablename + " ("
  var itext2 = ") VALUES("
  var i = 1
  for await (var parm of paramlist){
    if (i>1){
      inserttext += ", "
      itext2 += ", "
    }
    inserttext += parm
    itext2 += "$"
    itext2 += i
    insertvalues.push(insertObj[`${parm}`])
    i++
  }
  inserttext += itext2
  inserttext += ") RETURNING id"
  //console.log("Final Query:", inserttext)
  try{
    var dbres = await query(inserttext, insertvalues)
    //console.log("Object insert result:", dbres)
    if ((dbres)&&(dbres[0])){
      retObj.status = true
      retObj.result = dbres[0]
      if (dbres[0].id){
        console.log("Got returned ID!")
        retObj.insertId = dbres[0].id
      }
    }else{
      //
    }
  }catch(error){
    retObj.errormessages.push("Error Writing to Database")
    console.log(error)    
  }
  return retObj
  
}

async function checkValueUnique(param, value, tablename){
  var isunique = true
  var valupper = value.toUpperCase()
  var querytext = "SELECT COUNT(*) FROM " + tablename + " WHERE UPPER(" + param + ") LIKE UPPER($1)"
  //console.log(querytext, value)
  var dbcount = await query(querytext, [valupper])
  if ((dbcount)&&(dbcount[0])&&(dbcount[0].count)){
    var count = dbcount[0].count
    //console.log("Count", count)
    if (count > 0){
      isunique = false
    }
  }  
  return isunique
}

export{checkValueUnique, query, readquery, singlereadquery, writequery, checkedwritequery, pgpool, insertByParams, updateParamsById, insertObject}