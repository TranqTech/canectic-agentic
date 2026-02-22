//not needed. Should do everything this would in a model

import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";

const doorAuthTO = Number(process.env.doorAuthTO) || 15000;
const maxAuthBuffer = 4096; // Max bytes we'll accept before giving up

class DoorLauncher extends BaseHandler {
	constructor(call, doorstring) {
		super(call, "DoorAuth");
	}
}


export { DoorLauncher };