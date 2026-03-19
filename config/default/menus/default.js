
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
		{"sort_order": 0, "display": "Q) Quit Menu", "fg_clr": 13, "bg_clr": 0, "hotkey": "Q", "command_name": "previousMenu", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 1, "display": "D) Doors", "fg_clr": 10, "bg_clr": 0, "hotkey": "D", "command_name": "loadMenu", "command_arg": "Doors", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 3, "display": "M) Messages", "fg_clr": 4, "bg_clr": 0, "hotkey": "M", "command_name": "loadMenu", "command_arg": "Messages", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 4, "display": "E) Email/Netmail", "fg_clr": 7, "bg_clr": 0, "hotkey": "E", "command_name": "loadMenu", "command_arg": "Email", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 5, "display": "C) User Config", "fg_clr": 10, "bg_clr": 0, "hotkey": "C", "command_name": "loadMenu", "command_arg": "Config", "required_flags": [], "prohibited_flags": []},
		{"min_security": 60, "sort_order": 6, "display": "U) User List", "fg_clr": 11, "bg_clr": 0, "hotkey": "U", "command_name": "userList", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 7, "display": "L) Last Callers", "fg_clr": 12, "bg_clr": 0, "hotkey": "L", "command_name": "lastCallers", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 8, "display": "W) Who's Online", "fg_clr": 12, "bg_clr": 0, "hotkey": "W", "command_name": "whosOnline", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"sort_order": 9, "display": "G) Goodbye", "fg_clr": 10, "bg_clr": 0, "hotkey": "G", "command_name": "logOff", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "", "fg_clr": 4, "bg_clr": 0, "hotkey": "?", "command_name": "redrawMenu", "command_arg": "", "required_flags": [], "prohibited_flags": []}
	]
},
{
	"name": "Messages",
	"title": "Message Menu",
	"title_clr": "11",
	"display_entries": "True",
	"display_file": "",
	"display_file_type": "",
	"menu_type": "Hotkey",
	"menu_options_x_offset": "0",
	"menu_options_y_offset": "0",
	"menu_entries": [
		{"display": "Q) Quit Menu", "fg_clr": 13, "bg_clr": 0, "hotkey": "Q", "command_name": "previousMenu", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "J) Change Group", "fg_clr": 10, "bg_clr": 0, "hotkey": "J", "command_name": "msgGroupChange", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "A) Change Area", "fg_clr": 4, "bg_clr": 0, "hotkey": "A", "command_name": "msgAreaChange", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "E) Email/Netmail", "fg_clr": 7, "bg_clr": 0, "hotkey": "E", "command_name": "email", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "L) List Messages", "fg_clr": 7, "bg_clr": 0, "hotkey": "L", "command_name": "listMessages", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "N) New Messages", "fg_clr": 7, "bg_clr": 0, "hotkey": "N", "command_name": "newScan", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "P) Post Message", "fg_clr": 10, "bg_clr": 0, "hotkey": "P", "command_name": "postMessage", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "R) Read Messages", "fg_clr": 7, "bg_clr": 0, "hotkey": "R", "command_name": "readMessages", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "G) Goodbye", "fg_clr": 10, "bg_clr": 0, "hotkey": "G", "command_name": "logOff", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "H) Put it in H!", "fg_clr": 11, "bg_clr": 0, "hotkey": "H", "command_name": "logOff", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "", "fg_clr": 4, "bg_clr": 0, "hotkey": "?", "command_name": "redrawMenu", "command_arg": "", "required_flags": [], "prohibited_flags": []}
	]
},
{
	"name": "Doors",
	"title": "Doors Menu",
	"title_clr": "11",
	"display_entries": "True",
	"display_file": "",
	"display_file_type": "",
	"menu_type": "Hotkey",
	"menu_options_x_offset": "0",
	"menu_options_y_offset": "0",
	"menu_entries": [
		{"display": "Q) Quit Menu", "fg_clr": 13, "bg_clr": 0, "hotkey": "Q", "command_name": "previousMenu", "command_arg": "", "required_flags": [], "prohibited_flags": []},
		{"display": "1) Door Game 1", "fg_clr": 7, "bg_clr": 0, "hotkey": "1", "command_name": "runXtrn", "command_arg": "testdoor", "required_flags": [], "prohibited_flags": []},
		{"display": "2) Door Game 2", "fg_clr": 7, "bg_clr": 0, "hotkey": "2", "command_name": "runXtrn", "command_arg": "test", "required_flags": [], "prohibited_flags": []},
		{"display": "3) Dicewars", "fg_clr": 7, "bg_clr": 0, "hotkey": "3", "command_name": "runXtrn", "command_arg": "dice", "required_flags": [], "prohibited_flags": []},
		{"display": "4) Dicewars2", "fg_clr": 7, "bg_clr": 0, "hotkey": "4", "command_name": "runXtrn", "command_arg": "dice2", "required_flags": [], "prohibited_flags": []},
		{"display": "5) Lord Maint", "fg_clr": 7, "bg_clr": 0, "hotkey": "5", "command_name": "runXtrn", "command_arg": "lordmaint", "required_flags": [], "prohibited_flags": []},
		{"display": "6) Lord Reset", "fg_clr": 7, "bg_clr": 0, "hotkey": "6", "command_name": "runXtrn", "command_arg": "lordreset", "required_flags": [], "prohibited_flags": []},
		{"display": "D) Druglord", "fg_clr": 7, "bg_clr": 0, "hotkey": "D", "command_name": "runXtrn", "command_arg": "druglord", "required_flags": [], "prohibited_flags": []},
		{"display": "H) Ham Test", "fg_clr": 7, "bg_clr": 0, "hotkey": "H", "command_name": "runXtrn", "command_arg": "hamtest", "required_flags": [], "prohibited_flags": []},
		{"display": "L) LoRD", "fg_clr": 7, "bg_clr": 0, "hotkey": "L", "command_name": "runXtrn", "command_arg": "lord", "required_flags": [], "prohibited_flags": []},
		{"display": "M) LoRD 2", "fg_clr": 7, "bg_clr": 0, "hotkey": "M", "command_name": "runXtrn", "command_arg": "lord2", "required_flags": [], "prohibited_flags": []},
		{"display": "", "fg_clr": 4, "bg_clr": 0, "hotkey": "?", "command_name": "redrawMenu", "command_arg": "", "required_flags": [], "prohibited_flags": []}
	]
}
]


export{defaultmenuarray}

