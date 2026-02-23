
const defaultmenuarray = [
{
	"name": "Main",
	"title": "Main Menu",
	"title_clr": "11",
	"display_entries": "True",
	"display_file": "",
	"display_file_type": "",
	"menu_type": "Hotkey",
	"menu_options_x_offset": "0",
	"menu_options_y_offset": "0",
	"menu_entries": [
		{"sort_order": 0, "display": "Q) Quit Menu", "fg_clr": 13, "bg_clr": 0, "hotkey": "Q", "command_name": "exitStage", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 1, "display": "D) Doors", "fg_clr": 10, "bg_clr": 0, "hotkey": "D", "command_name": "loadMenu", "command_arg": "Doors", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 3, "display": "M) Messages", "fg_clr": 4, "bg_clr": 0, "hotkey": "M", "command_name": "loadMenu", "command_arg": "Messages", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 4, "display": "E) Email/Netmail", "fg_clr": 7, "bg_clr": 0, "hotkey": "E", "command_name": "loadMenu", "command_arg": "Email", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 5, "display": "C) User Config", "fg_clr": 10, "bg_clr": 0, "hotkey": "C", "command_name": "loadMenu", "command_arg": "Config", "required_flags": [], "prohibited_flags": []},
		{"min_security": 60, "sort_order": 6, "display": "U) User List", "fg_clr": 11, "bg_clr": 0, "hotkey": "U", "command_name": "userList", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 7, "display": "L) Last Callers", "fg_clr": 12, "bg_clr": 0, "hotkey": "L", "command_name": "lastCallers", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 8, "display": "G) Goodbye", "fg_clr": 10, "bg_clr": 0, "hotkey": "G", "command_name": "logOff", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "", "fg_clr": 4, "bg_clr": 0, "hotkey": "?", "command_name": "redrawMenu", "command_arg": "", "required_flags": [], "prohibited_flags": []}
	]
},
]


export{defaultmenuarray}

