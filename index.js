const express = require('express');
const twilio = require('twilio');
const app = express();

app.use(express.urlencoded({ extended: false }));

const SONG_URL = 'https://dl.dropboxusercontent.com/scl/fi/8g861s8bgkf79fh2z5krn/Satin-Sax-Whistle.mp3?rlkey=0ztiwj8t8fejgf4pajnqri1qr&st=ncd32its&raw=1';
const FORWARD_TO = '+16516159820';
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

// Step 1: Caller dials in - put them in a conference and play song while waiting
app.post('/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  const conferenceName = `conf_${callSid}`;
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

  // Simultaneously dial Number 3 in the background
  client.calls.create({
    url: `${process.env.APP_URL}/agent-join?conf=${conferenceName}`,
    to: FORWARD_TO,
    from: TWILIO_NUMBER,
  }).catch(err => console.error('Outbound call error:', err));

  // Put caller into conference - they hear song via waitUrl until agent joins
  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial();
  dial.conference(conferenceName, {
    startConferenceOnEnter: true,
    endConferenceOnExit: true,
    waitUrl: `${process.env.APP_URL}/wait-music`,
    waitMethod: 'GET',
    beep: false,
    muted: false,
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// Wait music - plays song to caller while they wait in conference
app.get('/wait-music', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.play({ loop: 99 }, SONG_URL);
  res.type('text/xml');
  res.send(twiml.toString());
});

// Step 2: Number 3 (GHL) answers - joins same conference, song stops automatically
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
