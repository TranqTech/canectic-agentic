import createError from 'http-errors'
import express from 'express'
import path from 'path'
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser'
import logger from 'morgan'
import * as dotenv from 'dotenv';

import {router as indexRouter} from '../routes/index.js';
import {router as adminRouter} from '../routes/admin.js';
import {router as usersRouter} from '../routes/users.js';
import { router as pmRouter } from '../routes/pm.js';

const node_env = process.env.NODE_ENV || "development"
var webserver = express();

// view engine setup
webserver.set('views', path.join(path.dirname("./"), 'src', 'views'));
webserver.set('view engine', 'pug');

//logs all http requests
//webserver.use(logger('dev'));

webserver.use(express.json());
webserver.use(express.urlencoded({ extended: false }));
webserver.use(cookieParser());
webserver.use(express.static( path.join(path.dirname("./"), 'public'), { dotfiles: 'allow' }));

webserver.use('/', indexRouter);
webserver.use('/admin', adminRouter);
webserver.use('/users', usersRouter);
webserver.use('/pm', pmRouter);

// catch 404 and forward to error handler
webserver.use(function(req, res, next) {
  next(createError(404));
});

// error handler
webserver.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  //res.locals.error = req.webserver.get('env') === 'development' ? err : {};
  res.locals.error = node_env === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

//module.exports = webserver;
export{webserver}
