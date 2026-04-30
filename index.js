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
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' },
  });
  const data = await res.json();
  return data?.contact?.id || null;
}

async function updateContact(contactId, fields) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}

async function addNoteToContact(contactId, note) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: note }),
  });
}

async function createContact(phone) {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId: GHL_LOCATION_ID, phone, source: 'Inbound Call' }),
  });
  const data = await res.json();
  return data?.contact?.id || null;
}

async function cancelActiveCalls(store) {
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
  for (const sid of (store.activeCallSids || [])) {
    try {
      await client.calls(sid).update({ status: 'canceled' });
      console.log(`Canceled call ${sid}`);
    } catch (e) {}
  }
  store.activeCallSids = [];
}

async function updateGHL(callData) {
  const { callerNumber, answeredBy, startTime, recordingUrl } = callData;
  const totalDuration = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
  const answeredByStr = answeredBy || 'No answer';

  console.log(`Updating GHL - Caller: ${callerNumber}, Duration: ${totalDuration}s, Answered by: ${answeredByStr}`);

  try {
    let contactId = await findContactByPhone(callerNumber);
    if (!contactId) contactId = await createContact(callerNumber);

    if (contactId) {
      await updateContact(contactId, {
        customFields: [
          { key: 'recording_url', field_value: recordingUrl || 'No recording' },
          { key: 'call_duration', field_value: String(totalDuration) },
          { key: 'answered_by', field_value: answeredByStr },
        ],
      });

      const date = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
      await addNoteToContact(contactId,
        `📞 Inbound Call — ${date}\n` +
        `Duration: ${totalDuration} seconds\n` +
        `Answered by: ${answeredByStr}\n` +
        `Recording: ${recordingUrl || 'Not available'}`
      );
      console.log(`GHL contact ${contactId} updated successfully`);
    }
  } catch (err) {
    console.error('GHL API error:', err);
  }
}

// --- Call Routes ---

app.post('/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From;
  const conferenceName = `conf_${callSid}`;
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

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
    dialOrder,
    roundCount: 0,
    activeCallSids: [],
    recordingUrl: null,
    ghlUpdated: false,
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
    statusCallbackEvent: ['start', 'end', 'join', 'leave'],
    statusCallbackMethod: 'POST',
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// Conference status callback - handles join/leave/end events
app.post('/caller-status', async (req, res) => {
  const conferenceName = req.query.conf;
  const store = callStore[conferenceName];
  const statusEvent = req.body.StatusCallbackEvent;
  const callSid = req.body.CallSid;

  console.log(`Conference event: ${statusEvent} for ${conferenceName}, CallSid: ${callSid}`);

  if (!store) {
    res.sendStatus(200);
    return;
  }

  if (statusEvent === 'participant-leave') {
    // Check if it's the caller (inbound) or agent leaving
    if (callSid === store.callSid) {
      // Caller hung up
      console.log(`Caller hung up - canceling all outbound calls`);
      store.callerHungUp = true;
      store.answered = true;
      await cancelActiveCalls(store);

      // Update GHL now since recording-done may not fire
      if (!store.ghlUpdated) {
        store.ghlUpdated = true;
        await updateGHL(store);
      }
    } else {
      // Agent hung up while caller still on line - dial next
      if (!store.callerHungUp && store.connected) {
        console.log(`Agent hung up - caller still on line, dialing next`);
        store.connected = false;
        store.answered = false;
        const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
        setTimeout(() => {
          const nextIndex = (store.dialOrder.indexOf(store.answeredBy) + 1);
          dialNext(client, conferenceName, nextIndex);
        }, 1000);
      }
    }
  } else if (statusEvent === 'conference-end') {
    console.log(`Conference ended for ${conferenceName}`);
    if (!store.ghlUpdated) {
      store.ghlUpdated = true;
      await updateGHL(store);
    }
  }

  res.sendStatus(200);
});

function dialNext(client, conferenceName, index) {
  const store = callStore[conferenceName];
  if (!store || store.callerHungUp || store.connected) {
    console.log(`Stopping dial loop for ${conferenceName}`);
    return;
  }

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
  }).then(call => {
    if (store && !store.callerHungUp) {
      store.activeCallSids = store.activeCallSids || [];
      store.activeCallSids.push(call.sid);
      console.log(`Tracking outbound call SID: ${call.sid}`);
    } else {
      client.calls(call.sid).update({ status: 'canceled' }).catch(() => {});
    }
  }).catch(err => console.error('Dial error:', err));
}

// Fires when outbound call is answered or ends
app.post('/dial-status', (req, res) => {
  const conferenceName = req.query.conf;
  const index = parseInt(req.query.index);
  const callStatus = req.body.CallStatus;
  const store = callStore[conferenceName];
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

  const number = store?.dialOrder?.[index] || 'unknown';
  console.log(`/dial-status for ${number} - CallStatus: ${callStatus}`);

  if (!store || store.callerHungUp) {
    console.log(`Caller already gone - hanging up on ${number}`);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, the caller has hung up.');
    twiml.hangup();
    res.type('text/xml');
    res.send(twiml.toString());
    return;
  }

  if (store.connected && callStatus !== 'in-progress') {
    console.log(`Already connected, ignoring status: ${callStatus}`);
    res.sendStatus(200);
    return;
  }

  if (callStatus === 'in-progress') {
    store.answered = true;
    store.connected = true;
    store.answeredBy = number;
    console.log(`${number} answered - joining conference`);

    const twiml = new twilio.twiml.VoiceResponse();
    const dial = twiml.dial();
    dial.conference(conferenceName, {
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      beep: false,
    });

    res.type('text/xml');
    res.send(twiml.toString());

  } else if (callStatus === 'no-answer' || callStatus === 'busy' || callStatus === 'failed') {
    console.log(`No answer from ${number} (${callStatus}), trying next...`);
    store.connected = false;

    setTimeout(() => {
      dialNext(client, conferenceName, index + 1);
    }, 1000);

    res.sendStatus(200);

  } else if (callStatus === 'completed') {
    if (!store.callerHungUp && !store.connected) {
      console.log(`Call ${number} completed, dialing next if needed...`);
    }
    res.sendStatus(200);

  } else {
    res.sendStatus(200);
  }
});

// Recording done - update GHL with recording URL
app.post('/recording-done', async (req, res) => {
  const conferenceName = req.query.conf;
  const recordingUrl = req.body.RecordingUrl + '.mp3';
  const store = callStore[conferenceName];

  console.log(`Recording done for ${conferenceName}: ${recordingUrl}`);

  if (store) {
    store.recordingUrl = recordingUrl;
    if (!store.ghlUpdated) {
      store.ghlUpdated = true;
      await updateGHL({ ...store, recordingUrl });
    } else {
      // GHL already updated without recording URL - update just the recording
      try {
        let contactId = await findContactByPhone(store.callerNumber);
        if (contactId) {
          await updateContact(contactId, {
            customFields: [{ key: 'recording_url', field_value: recordingUrl }],
          });
          console.log(`Updated recording URL on contact ${contactId}`);
        }
      } catch (err) {
        console.error('GHL recording update error:', err);
      }
    }
    delete callStore[conferenceName];
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hold music server running on port ${PORT}`));
