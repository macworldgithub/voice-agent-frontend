import { useState, useEffect, useRef } from 'react';
import './App.css';

const API_BASE = 'https://voice-agent-backend-beta.vercel.app';


function App() {
  const [callActive, setCallActive]     = useState(false);
  const [status, setStatus]             = useState('Ready to start');
  const [recordingUrl, setRecordingUrl] = useState(null);

  // Keep these for logic — but not displayed anymore
  const transcriptLinesRef = useRef([]);     // we still collect for email
  const summaryTextRef     = useRef('');     // we still collect for email

  const recognitionRef     = useRef(null);
  const mediaRecorderRef   = useRef(null);
  const audioChunksRef     = useRef([]);
  const messagesRef        = useRef([]);
  const selectedVoiceRef   = useRef(null);
  const isListeningRef     = useRef(false);
  const isSpeakingRef      = useRef(false);
  const callActiveRef      = useRef(false);

  useEffect(() => { callActiveRef.current = callActive; }, [callActive]);

  // Speech Recognition setup
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Voice recognition is not supported in this browser.");
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous     = true;
    rec.interimResults = false;
    rec.lang           = 'en-US';
    recognitionRef.current = rec;

    return () => rec.abort?.();
  }, []);

  // TTS voice selection
  useEffect(() => {
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      selectedVoiceRef.current =
        voices.find(v => /Google|Microsoft|Natural/i.test(v.name)) ||
        voices[0] ||
        null;
    };

    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();
  }, []);

  const speak = (text) => {
    if (recognitionRef.current && isListeningRef.current) {
      recognitionRef.current.stop?.();
      isListeningRef.current = false;
    }

    isSpeakingRef.current = true;
    setStatus('Speaking...');

    const utter = new SpeechSynthesisUtterance(text);
    if (selectedVoiceRef.current) utter.voice = selectedVoiceRef.current;
    utter.rate  = 1.05;
    utter.pitch = 1.0;

    utter.onend = () => {
      isSpeakingRef.current = false;
      if (callActiveRef.current) {
        setTimeout(startListeningIfNeeded, 320);
      }
      setStatus('Listening...');
    };

    utter.onerror = () => {
      isSpeakingRef.current = false;
      if (callActiveRef.current) startListeningIfNeeded();
    };

    window.speechSynthesis.speak(utter);

    // Collect for email (not shown on UI)
    transcriptLinesRef.current.push({ role: 'agent', text });
  };

  const startListeningIfNeeded = () => {
    if (!recognitionRef.current) return;
    if (!callActiveRef.current) return;
    if (isListeningRef.current || isSpeakingRef.current) return;

    try {
      recognitionRef.current.start();
      isListeningRef.current = true;
      setStatus('Listening...');
    } catch (err) {
      console.warn('start failed', err);
      isListeningRef.current = false;
    }
  };

  useEffect(() => {
    const rec = recognitionRef.current;
    if (!rec) return;

    rec.onresult = async (event) => {
      const text = event.results[event.results.length - 1][0].transcript.trim();
      if (!text) return;

      rec.stop?.();
      isListeningRef.current = false;

      // Collect for email
      transcriptLinesRef.current.push({ role: 'user', text });
      messagesRef.current.push({ role: 'user', content: text });

      setStatus('Thinking...');

      try {
        const assistantText = await backendChat(messagesRef.current);
        messagesRef.current.push({ role: 'assistant', content: assistantText });

        const lower = assistantText.toLowerCase();
        if (lower.includes('goodbye') || lower.includes('end call') || 
            lower.includes('hang up') || lower.includes('terminate')) {
          transcriptLinesRef.current.push({ role: 'agent', text: assistantText });
          endCall();
          return;
        }

        speak(assistantText);
      } catch (err) {
        console.error(err);
        setStatus('Connection error — please try again');
        setTimeout(startListeningIfNeeded, 1200);
      }
    };

    rec.onend = () => {
      isListeningRef.current = false;
      if (callActiveRef.current && !isSpeakingRef.current) {
        setTimeout(startListeningIfNeeded, 250);
      }
    };

    rec.onerror = (e) => {
      isListeningRef.current = false;
      if (e.error === 'no-speech') {
        setTimeout(startListeningIfNeeded, 400);
      } else if (e.error.includes('permission')) {
        setStatus('Microphone access denied');
      } else {
        setTimeout(startListeningIfNeeded, 800);
      }
    };
  }, []);

  const backendChat = async (msgs) => {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: msgs }),
    });
    if (!res.ok) throw new Error('chat failed');
    const { assistant } = await res.json();
    return assistant || '';
  };

  const backendSummary = async (fullTranscript) => {
    try {
      const res = await fetch(`${API_BASE}/api/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: fullTranscript }),
      });
      if (!res.ok) throw new Error('summary endpoint failed');
      const { summary } = await res.json();
      return summary || 'No summary was generated';
    } catch (err) {
      console.error('Summary generation failed:', err);
      return 'Could not create summary';
    }
  };

  const uploadEmail = async (blob, transcriptText, summaryText) => {
    try {
      const form = new FormData();
      form.append('transcript', transcriptText || 'No transcript available');
      form.append('summary',    summaryText    || 'No summary available');
      if (blob) {
        form.append('recording', blob, 'mortgage-call.webm');
      }

      const res = await fetch(`${API_BASE}/api/email`, {
        method: 'POST',
        body: form,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Email endpoint failed');
      }

      return await res.json();
    } catch (err) {
      console.error('Email sending failed:', err);
      throw err;
    }
  };

  const startCall = async () => {
    setCallActive(true);
    transcriptLinesRef.current = [];
    summaryTextRef.current = '';
    setRecordingUrl(null);
    messagesRef.current = [];
    audioChunksRef.current = [];
    isListeningRef.current = false;
    isSpeakingRef.current = false;

    setStatus('Starting call...');

    // Start recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = e => audioChunksRef.current.push(e.data);
      recorder.start();
    } catch (err) {
      console.error('Microphone access error:', err);
      alert("Couldn't access microphone");
      setCallActive(false);
      return;
    }

    // Get greeting
    try {
      const greeting = await backendChat([
        { role: 'user', content: 'Start the conversation with a greeting.' }
      ]);
      messagesRef.current.push({ role: 'assistant', content: greeting });
      speak(greeting);
    } catch (err) {
      setStatus('Failed to start conversation');
      endCall();
    }
  };

  const endCall = async () => {
    setCallActive(false);
    setStatus('Call ended');

    if (recognitionRef.current && isListeningRef.current) {
      recognitionRef.current.stop?.();
    }

    // Stop recording & create blob
    let recordingBlob = null;
    if (mediaRecorderRef.current) {
      await new Promise(resolve => {
        mediaRecorderRef.current.onstop = () => {
          recordingBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          setRecordingUrl(URL.createObjectURL(recordingBlob));
          resolve();
        };
        mediaRecorderRef.current.stop?.();
      });
    }

    // Prepare content for email
    const fullTranscript = transcriptLinesRef.current
      .map(l => `${l.role === 'user' ? 'You' : 'Agent'}: ${l.text}`)
      .join('\n\n');

    let summ = '';
    try {
      summ = await backendSummary(fullTranscript);
      summaryTextRef.current = summ;
      setStatus('Creating summary • Sending email...');
    } catch {
      summaryTextRef.current = 'Could not generate summary';
    }

    try {
      await uploadEmail(recordingBlob, fullTranscript, summaryTextRef.current);
      setStatus('Email sent successfully');
    } catch (err) {
      setStatus('Could not send email');
      console.error('Final email error:', err);
    }
  };

  return (
    <div className="voice-agent-app">
      <div className="main-content">
        <h1>Mortgage Voice Agent</h1>
        <p className="subtitle">Speak naturally — just like a phone call</p>

        <div className={`status-circle ${callActive ? (isSpeakingRef.current ? 'speaking' : 'listening') : ''}`}>
          <div className="inner-circle">
            {callActive
              ? (isSpeakingRef.current ? 'Speaking' : 'Listening')
              : 'Ready'}
          </div>
        </div>

        <div className="status-text">{status}</div>

        <div className="controls">
          {!callActive ? (
            <button className="big-btn start" onClick={startCall}>
              Start Call
            </button>
          ) : (
            <button className="big-btn end" onClick={endCall}>
              End Call
            </button>
          )}
        </div>

        {recordingUrl && (
          <div className="download-section">
            <a href={recordingUrl} download="mortgage-call.webm" className="download-link">
              Download this call recording
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
