const express = require('express');
const twilio = require('twilio');
const app = express();

app.use(express.urlencoded({ extended: false }));

const SONG_URL = 'https://dl.dropboxusercontent.com/scl/fi/8g861s8bgkf79fh2z5krn/Satin-Sax-Whistle.mp3?rlkey=0ztiwj8t8fejgf4pajnqri1qr&st=ncd32its&raw=1';
const FORWARD_TO = '+16516159820';
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const WAIT_MUSIC_BIN_URL = process.env.WAIT_MUSIC_BIN_URL;

app.post('/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  const conferenceName = `conf_${callSid}`;
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

  client.calls.create({
    url: `${process.env.APP_URL}/agent-join?conf=${conferenceName}`,
    to: FORWARD_TO,
    from: TWILIO_NUMBER,
  }).catch(err => console.error('Outbound call error:', err));

  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial();
  dial.conference(conferenceName, {
    startConferenceOnEnter: true,
    endConferenceOnExit: true,
    waitUrl: WAIT_MUSIC_BIN_URL,
    waitMethod: 'GET',
    beep: false,
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/agent-join', (req, res) => {
  const conferenceName = req.query.conf;

  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial();
  dial.conference(conferenceName, {
    startConferenceOnEnter: true,
    endConferenceOnExit: true,
    beep: false,
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hold music server running on port ${PORT}`));
