import { defaultmenuarray } from '../../config/default/menus/default.js'

async function getMenu(name){
	//
	const defaultmenu = defaultmenuarray.find(menu => menu.name === name)
	console.log("Menu Found")
	return defaultmenu
}

async function menuExists(name){
	const defaultmenu = defaultmenuarray.find(menu => menu.name === name)
	if (defaultmenu){
		return true
	}else{
		return false
	}
}

export{getMenu, menuExists}