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

// Store call info in memory
const callStore = {};

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
  const url = `https://services.leadconnectorhq.com/contacts/${contactId}`;
  await fetch(url, {
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
  const url = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: note }),
  });
}

async function createContact(phone, fields) {
  const url = `https://services.leadconnectorhq.com/contacts/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      locationId: GHL_LOCATION_ID,
      phone,
      ...fields,
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

  callStore[conferenceName] = {
    startTime: Date.now(),
    callerNumber,
    callSid,
    answeredBy: null,
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
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

function dialNext(client, conferenceName, index) {
  if (index >= TEAM.length) index = 0;
  const number = TEAM[index];
  console.log(`Dialing ${number} (index ${index})`);

  client.calls.create({
    url: `${APP_URL}/agent-join?conf=${conferenceName}&index=${index}`,
    to: number,
    from: TWILIO_NUMBER,
    timeout: 20,
    statusCallback: `${APP_URL}/no-answer?conf=${conferenceName}&index=${index}`,
    statusCallbackEvent: ['no-answer', 'busy', 'failed'],
    statusCallbackMethod: 'POST',
  }).catch(err => console.error('Dial error:', err));
}

app.post('/agent-join', (req, res) => {
  const conferenceName = req.query.conf;
  if (callStore[conferenceName]) {
    callStore[conferenceName].answeredBy = req.body.To;
    callStore[conferenceName].answerTime = Date.now();
  }

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

app.post('/no-answer', (req, res) => {
  const conferenceName = req.query.conf;
  const index = parseInt(req.query.index);
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

  console.log(`No answer from ${TEAM[index]}, trying next...`);
  setTimeout(() => {
    dialNext(client, conferenceName, index + 1);
  }, 2000);

  res.sendStatus(200);
});

// Recording done - update GHL contact via API
app.post('/recording-done', async (req, res) => {
  const conferenceName = req.query.conf;
  const recordingUrl = req.body.RecordingUrl + '.mp3';
  const recordingDuration = req.body.RecordingDuration;
  const callData = callStore[conferenceName] || {};

  const totalDuration = callData.startTime
    ? Math.round((Date.now() - callData.startTime) / 1000)
    : recordingDuration;

  const callerNumber = callData.callerNumber;
  const answeredBy = callData.answeredBy || 'No answer';

  console.log(`Call ended. Caller: ${callerNumber}, Duration: ${totalDuration}s, Answered by: ${answeredBy}`);

  try {
    // Find or create contact in GHL
    let contactId = await findContactByPhone(callerNumber);

    if (!contactId) {
      console.log('Contact not found, creating new one...');
      contactId = await createContact(callerNumber, {
        firstName: 'Unknown',
        source: 'Inbound Call',
      });
    }

    if (contactId) {
      // Update contact with call details
      await updateContact(contactId, {
        customFields: [
          { key: 'recording_url', field_value: recordingUrl },
          { key: 'call_duration', field_value: String(totalDuration) },
          { key: 'answered_by', field_value: answeredBy },
        ],
      });

      // Add note to contact timeline
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
