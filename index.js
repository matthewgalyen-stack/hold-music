const express = require('express');
const twilio = require('twilio');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const WAIT_MUSIC_URL = process.env.WAIT_MUSIC_BIN_URL;
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const APP_URL = process.env.APP_URL;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

const TEAM = ['+16128592408', '+16125700275'];

const callStore = {};

// Shuffle array randomly (Fisher-Yates)
function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// --- GHL API Helpers ---

async function findContactByPhone(phone) {
  const url = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&number=${encodeURIComponent(phone)}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
    },
  });
  const data = await res.json();
  return data?.contact?.id || null;
}

async function updateContact(contactId, fields) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(fields),
  });
}

async function addNoteToContact(contactId, note) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: note }),
  });
}

async function createContact(phone) {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      locationId: GHL_LOCATION_ID,
      phone,
      source: 'Inbound Call',
    }),
  });
  const data = await res.json();
  return data?.contact?.id || null;
}

// --- Call Routes ---

app.post('/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From;
  const conferenceName = `conf_${callSid}`;
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

  // Generate a new random order for this call
  const dialOrder = shuffleArray(TEAM);
  console.log(`Dial order for this call: ${dialOrder.join(', ')}`);

  callStore[conferenceName] = {
    startTime: Date.now(),
    callerNumber,
    callSid,
    answeredBy: null,
    answered: false,
    callerHungUp: false,
    connected: false,
    dialOrder,         // randomized order stored per call
    roundCount: 0,     // track how many full rounds completed
  };

  setTimeout(() => {
    dialNext(client, conferenceName, 0);
  }, 2000);

  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial();
  dial.conference(conferenceName, {
    startConferenceOnEnter: false,
    endConferenceOnExit: true,
    waitUrl: WAIT_MUSIC_URL,
    waitMethod: 'GET',
    beep: false,
    record: 'record-from-start',
    recordingStatusCallback: `${APP_URL}/recording-done?conf=${conferenceName}`,
    recordingStatusCallbackMethod: 'POST',
    statusCallback: `${APP_URL}/caller-status?conf=${conferenceName}`,
    statusCallbackEvent: ['leave'],
    statusCallbackMethod: 'POST',
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// Fires when caller leaves the conference
app.post('/caller-status', (req, res) => {
  const conferenceName = req.query.conf;
  if (callStore[conferenceName]) {
    console.log(`Caller left conference ${conferenceName} - stopping all dialing`);
    callStore[conferenceName].callerHungUp = true;
    callStore[conferenceName].answered = true;
  }
  res.sendStatus(200);
});

function dialNext(client, conferenceName, index) {
  const store = callStore[conferenceName];

  if (!store || store.callerHungUp || store.connected) {
    console.log(`Stopping dial loop for ${conferenceName}`);
    return;
  }

  // When we complete a full round, reshuffle for equal weight distribution
  if (index >= store.dialOrder.length) {
    store.roundCount++;
    store.dialOrder = shuffleArray(TEAM);
    console.log(`Round ${store.roundCount} complete. New order: ${store.dialOrder.join(', ')}`);
    index = 0;
  }

  const number = store.dialOrder[index];
  console.log(`Dialing ${number} (position ${index + 1} of ${store.dialOrder.length})`);

  client.calls.create({
    url: `${APP_URL}/dial-status?conf=${conferenceName}&index=${index}`,
    to: number,
    from: TWILIO_NUMBER,
    timeout: 20,
    statusCallback: `${APP_URL}/dial-status?conf=${conferenceName}&index=${index}`,
    statusCallbackEvent: ['no-answer', 'busy', 'failed', 'completed'],
    statusCallbackMethod: 'POST',
  }).catch(err => console.error('Dial error:', err));
}

// Fires when outbound call is answered (url param) OR ends via statusCallback
app.post('/dial-status', (req, res) => {
  const conferenceName = req.query.conf;
  const index = parseInt(req.query.index);
  const callStatus = req.body.CallStatus;
  const store = callStore[conferenceName];
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

  const number = store?.dialOrder?.[index] || 'unknown';
  console.log(`/dial-status for ${number} - CallStatus: ${callStatus}`);

  // If caller already hung up, do nothing
  if (!store || store.callerHungUp) {
    console.log(`Caller already gone, ignoring`);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.hangup();
    res.type('text/xml');
    res.send(twiml.toString());
    return;
  }

  // If already connected to someone, ignore stale callbacks
  if (store.connected && callStatus !== 'in-progress') {
    console.log(`Already connected, ignoring status: ${callStatus}`);
    res.sendStatus(200);
    return;
  }

  if (callStatus === 'in-progress') {
    // Called party answered - join the conference
    store.answered = true;
    store.connected = true;
    store.answeredBy = number;
    console.log(`${number} answered - joining conference`);

    const twiml = new twilio.twiml.VoiceResponse();
    const dial = twiml.dial();
    dial.conference(conferenceName, {
      startConferenceOnEnter: true,
      endConferenceOnExit: false,
      beep: false,
    });

    res.type('text/xml');
    res.send(twiml.toString());
  } else if (callStatus === 'no-answer' || callStatus === 'busy' || callStatus === 'failed') {
    // No answer - try next number
    console.log(`No answer from ${number} (${callStatus}), trying next...`);
    store.connected = false;

    setTimeout(() => {
      dialNext(client, conferenceName, index + 1);
    }, 1000);

    res.sendStatus(200);
  } else if (callStatus === 'completed') {
    // Agent hung up - if caller still there, dial next
    if (!store.callerHungUp) {
      console.log(`Agent ${number} hung up, caller still on line - dialing next...`);
      store.connected = false;
      store.answered = false;

      setTimeout(() => {
        dialNext(client, conferenceName, index + 1);
      }, 1000);
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(200);
  }
});

// Recording done - update GHL contact
app.post('/recording-done', async (req, res) => {
  const conferenceName = req.query.conf;
  const recordingUrl = req.body.RecordingUrl + '.mp3';
  const callData = callStore[conferenceName] || {};

  const totalDuration = callData.startTime
    ? Math.round((Date.now() - callData.startTime) / 1000)
    : req.body.RecordingDuration;

  const callerNumber = callData.callerNumber;
  const answeredBy = callData.answeredBy || 'No answer';

  console.log(`Call ended. Caller: ${callerNumber}, Duration: ${totalDuration}s, Answered by: ${answeredBy}`);

  try {
    let contactId = await findContactByPhone(callerNumber);
    if (!contactId) {
      contactId = await createContact(callerNumber);
    }

    if (contactId) {
      await updateContact(contactId, {
        customFields: [
          { key: 'recording_url', field_value: recordingUrl },
          { key: 'call_duration', field_value: String(totalDuration) },
          { key: 'answered_by', field_value: answeredBy },
        ],
      });

      const date = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
      await addNoteToContact(contactId,
        `📞 Inbound Call — ${date}\n` +
        `Duration: ${totalDuration} seconds\n` +
        `Answered by: ${answeredBy}\n` +
        `Recording: ${recordingUrl}`
      );

      console.log(`GHL contact ${contactId} updated successfully`);
    }
  } catch (err) {
    console.error('GHL API error:', err);
  }

  delete callStore[conferenceName];
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hold music server running on port ${PORT}`));
