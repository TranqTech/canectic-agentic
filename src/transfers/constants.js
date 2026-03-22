// transfers/constants.js — Shared byte constants for XMODEM and ZMODEM protocols.

// --- Common control characters ---
var SOH  = 0x01;  // Start of Header (XMODEM 128-byte block)
var STX  = 0x02;  // Start of Text (XMODEM 1K block)
var EOT  = 0x04;  // End of Transmission
var ACK  = 0x06;  // Acknowledge
var NAK  = 0x15;  // Negative Acknowledge
var CAN  = 0x18;  // Cancel (3x CAN = abort)
var SUB  = 0x1A;  // Substitute (padding byte in XMODEM)
var XON  = 0x11;  // Resume transmission
var XOFF = 0x13;  // Pause transmission
var CR   = 0x0D;  // Carriage return
var LF   = 0x0A;  // Line feed
var BS   = 0x08;  // Backspace

// --- ZMODEM-specific ---
var ZPAD  = 0x2A;  // '*' — padding before ZDLE in hex headers
var ZDLE  = 0x18;  // ZMODEM Data Link Escape (same as CAN)
var ZDLEE = 0x58;  // Escaped ZDLE value (ZDLE XOR 0x40)
var ZBIN  = 0x41;  // 'A' — binary header with CRC-16
var ZHEX  = 0x42;  // 'B' — hex header with CRC-16
var ZBIN32 = 0x43; // 'C' — binary header with CRC-32

// ZMODEM frame types (header type byte)
var ZRQINIT  = 0;   // Request receive init
var ZRINIT   = 1;   // Receive init
var ZSINIT   = 2;   // Send init sequence (optional)
var ZACK     = 3;   // ACK to above
var ZFILE    = 4;   // File name from sender
var ZSKIP    = 5;   // Skip this file
var ZNAK     = 6;   // Last packet was garbled
var ZABORT   = 7;   // Abort batch transfers
var ZFIN     = 8;   // Finish session
var ZRPOS    = 9;   // Resume data transmission at this position
var ZDATA    = 10;  // Data packet(s) follow
var ZEOF     = 11;  // End of file
var ZFERR    = 12;  // Fatal read or write error detected
var ZCRC     = 13;  // Request for file CRC and target position
var ZCHALLENGE = 14; // Receiver's challenge
var ZCOMPL   = 15;  // Request is complete
var ZCAN     = 16;  // Other end cancelled with CAN chars
var ZFREECNT = 17;  // Request for free bytes on filesystem
var ZCOMMAND = 18;  // Command from sending program
var ZSTDERR  = 19;  // Output to standard error

// ZMODEM subpacket end types
var ZCRCG = 0x69;  // More data follows (no ACK expected)
var ZCRCQ = 0x6A;  // More data follows, ZACK expected
var ZCRCE = 0x68;  // End of file data, no ACK expected
var ZCRCW = 0x6B;  // End of frame, ZACK expected, then more data

// ZMODEM ZRINIT capability flags (ZF0)
var CANFDX  = 0x01;  // Rx can send and receive true FDX
var CANOVIO = 0x02;  // Rx can receive data during disk I/O
var CANBRK  = 0x04;  // Rx can send a break signal
var CANCRY  = 0x08;  // Receiver can decrypt
var CANLZW  = 0x10;  // Receiver can uncompress
var CANFC32 = 0x20;  // Receiver can use 32 bit CRC
var ESCCTL  = 0x40;  // Receiver wants ctl chars escaped
var ESC8    = 0x80;  // Receiver wants 8th bit escaped

// ZMODEM ZFILE conversion options (ZF0)
var ZCBIN   = 1;  // Binary transfer
var ZCNL    = 2;  // Convert NL to local convention
var ZCRESUM = 3;  // Resume interrupted file transfer

export {
	SOH, STX, EOT, ACK, NAK, CAN, SUB, XON, XOFF, CR, LF, BS,
	ZPAD, ZDLE, ZDLEE, ZBIN, ZHEX, ZBIN32,
	ZRQINIT, ZRINIT, ZSINIT, ZACK, ZFILE, ZSKIP, ZNAK, ZABORT,
	ZFIN, ZRPOS, ZDATA, ZEOF, ZFERR, ZCRC, ZCHALLENGE, ZCOMPL,
	ZCAN, ZFREECNT, ZCOMMAND, ZSTDERR,
	ZCRCG, ZCRCQ, ZCRCE, ZCRCW,
	CANFDX, CANOVIO, CANBRK, CANCRY, CANLZW, CANFC32, ESCCTL, ESC8,
	ZCBIN, ZCNL, ZCRESUM
};
