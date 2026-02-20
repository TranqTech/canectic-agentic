//imports
import express from 'express';
const router = express.Router();
// ..stuff below
import { DateTime } from "luxon";
import bodyParser from 'body-parser'
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import sanitizeHtml from 'sanitize-html';
import mobile from 'is-mobile';

//internals
//import * as sessionStore from "../models/sessionStore.js"

//setup
router.use(cookieParser());
var urlencodedParser = bodyParser.urlencoded({ limit: '250mb', extended: true })

//variables and const
const faviconlink = process.env.faviconlink || "/images/favicon.ico"
const boardname = process.env.boardname;
const sitetld = process.env.sitetld
const loadcorsorigin = process.env.corsorigin
const sitedomain = process.env.sitedomain
const fulldomain = "https://" + sitedomain
const basedir = process.cwd()


/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('public/index', { title: 'Express' });
});

export{router}