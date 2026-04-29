const express = require('express');
const twilio = require('twilio');
const app = express();

app.use(express.urlencoded({ extended: false }));

const SONG_URL = 'https://dl.dropboxusercontent.com/scl/fi/8g861s8bgkf79fh2z5krn/Satin-Sax-Whistle.mp3?rlkey=0ztiwj8t8fejgf4pajnqri1qr&st=ncd32its&raw=1';
const FORWARD_TO = '+16516159820';
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

// Step 1: Incoming call hits this endpoint
// Immediately plays song to caller AND dials Number 3 in background
app.post('/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

  // Dial Number 3 in the background as a separate call leg
  client.calls.create({
    url: `${process.env.APP_URL}/bridge?originalCall=${callSid}`,
    to: FORWARD_TO,
    from: TWILIO_NUMBER,
  });

  // Caller hears the song on loop while waiting
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.play({ loop: 99 }, SONG_URL);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Step 2: Number 3 answers - bridge both legs together, song stops
app.post('/bridge', (req, res) => {
  const originalCall = req.query.originalCall;
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

  // Stop the song on the caller's leg and bridge them together
  client.calls(originalCall).update({
    twiml: `<Response><Dial><Number>${FORWARD_TO}</Number></Dial></Response>`
  });

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Connecting you now.');
  res.type('text/xml');
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hold music server running on port ${PORT}`));
