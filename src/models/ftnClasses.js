class Packet{
	constructor(){
		this.Password
		this.PacketType
		this.Source
		this.SourceZone
		this.SourceNet
		this.SourceNode
		this.Destination
		this.DestinationZone
		this.DestinationNet
		this.DestinationNode
		this.DateTime
		this.Year
		this.Month
		this.Day
		this.Hour
		this.Minute
		this.Second
		this.Baud
		this.ProdCode
		this.Serial
		this.MessageCount
		this.Messages = []
	}
}

class Message{
	constructor(){
		this.Type = "Netmail"
		this.AreaTag = "None"
		this.TZUTC = ""
		this.Path = ""
		this.SeenBy = ""
		this.Source = ""
		this.SourceNode = ""
		this.SourceNet = 0
		this.Destination = ""
		this.DestinationNet = 0
		this.DestinationNode = 0
		this.Attribute = ""
		this.Cost = 0
		this.FromUser = ""
		this.ToUser = ""
		this.DateTime = ""
		this.Subject = ""
		this.MsgId = ""
		this.ReplyTo = ""
		this.ThreadId = ""
		this.TosserId = ""
		this.OptionalAttributes = []
		this.RawText = ""
		this.BodyText = ""
		this.OriginLine = ""
	}
}


export {Packet, Message}