"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Channel = "alpha" | "beta" | "gamma";
type Port = "north" | "east" | "south";
type SignalColor = "coral" | "cobalt" | "amber";
type Glyph = "triangle" | "circle" | "diamond";
type Actor = "human" | "relay" | "facility";
type GameStatus = "dormant" | "playing" | "won";
type GameStage = 1 | 2 | 3;
type Screen = "wake" | "briefing" | "mission";
type ConnectionPath = "chatgpt-desktop" | "chrome-plugin";

type Signal = { color: SignalColor; glyph: Glyph };
type Puzzle = {
  signals: Signal[];
  colorCodes: Record<SignalColor, number>;
  glyphOffsets: Record<Glyph, number>;
  routes: Record<Channel, Port>;
};

type StoryEvent = { id: number; actor: Actor; message: string };

type GameState = {
  missionId: string;
  seedIndex: number;
  status: GameStatus;
  stage: GameStage;
  startedAt: number;
  finishedAt: number | null;
  mistakes: number;
  toolCalls: number;
  activeChannel: Channel | null;
  connections: Partial<Record<Channel, Port>>;
  armedUntil: number;
  relayMessage: string;
  events: StoryEvent[];
  nextEventId: number;
};

type ModelContext = {
  registerTool: (tool: Record<string, unknown>) => Promise<void> | void;
  unregisterTool?: (name: string) => Promise<void> | void;
};

const GAME_KEY = "relay-room-story-v2";
const BEST_KEY = "relay-room-best-v1";
const CONNECTION_PATH_KEY = "relay-room-connection-path-v1";
const TOOL_COUNT = 8;
const AUTHORIZATION_WINDOW_MS = 90000;
const AUTHORIZATION_WINDOW_SECONDS = AUTHORIZATION_WINDOW_MS / 1000;
const CHANNELS: Channel[] = ["alpha", "beta", "gamma"];
const PORTS: Port[] = ["north", "east", "south"];
const PORT_DIGITS: Record<Port, number> = { north: 1, east: 2, south: 3 };
const GLYPHS: Record<Glyph, string> = { triangle: "▲", circle: "●", diamond: "◆" };
const OPENING_PROMPT = "Relay, I'm awake. I don't know where I am. Can you hear me? Use this page's Site tools (WebMCP), not visual browser controls. First call relay_start_link, then relay_get_briefing, and help me escape.";
const VOICE_ROOT = "/voice/relay";
const RELAY_VOICE = {
  signalDetected: "00-signal-detected.mp3",
  identification: "01-relay-identification.mp3",
  compatibleIntro: "02-intro-webmcp-compatible.mp3",
  unsupportedIntro: "03-intro-webmcp-unsupported.mp3",
  awakening: "10-awakening.mp3",
  noVisualFeed: "11-no-visual-feed.mp3",
  observationAccepted: "12-observation-accepted.mp3",
  observationRejected: "13-observation-rejected.mp3",
  systemUnlocked: "15-system-unlocked.mp3",
  remoteTerminal: "20-remote-terminal.mp3",
  channelIntrusion: "21-channel-intrusion.mp3",
  finalDecision: "22-final-decision.mp3",
  gateOpen: "23-gate-open.mp3",
  linkTerminated: "24-link-terminated.mp3",
  reconnection: "25-reconnection.mp3",
} as const;
type RelayVoiceClip = (typeof RELAY_VOICE)[keyof typeof RELAY_VOICE];

const PUZZLES: Puzzle[] = [
  {
    signals: [
      { color: "coral", glyph: "triangle" },
      { color: "cobalt", glyph: "circle" },
      { color: "amber", glyph: "diamond" },
    ],
    colorCodes: { coral: 4, cobalt: 7, amber: 2 },
    glyphOffsets: { triangle: 1, circle: 0, diamond: 3 },
    routes: { alpha: "east", beta: "north", gamma: "south" },
  },
  {
    signals: [
      { color: "amber", glyph: "circle" },
      { color: "coral", glyph: "diamond" },
      { color: "cobalt", glyph: "triangle" },
    ],
    colorCodes: { coral: 6, cobalt: 1, amber: 8 },
    glyphOffsets: { triangle: 2, circle: 0, diamond: 1 },
    routes: { alpha: "south", beta: "east", gamma: "north" },
  },
  {
    signals: [
      { color: "cobalt", glyph: "diamond" },
      { color: "amber", glyph: "triangle" },
      { color: "coral", glyph: "circle" },
    ],
    colorCodes: { coral: 3, cobalt: 5, amber: 7 },
    glyphOffsets: { triangle: 1, circle: 4, diamond: 2 },
    routes: { alpha: "north", beta: "south", gamma: "east" },
  },
];

function createMission(seedIndex: number, startedAt = 0): GameState {
  return {
    missionId: `QRL-${String(seedIndex + 1).padStart(2, "0")}`,
    seedIndex,
    status: startedAt ? "playing" : "dormant",
    stage: 1,
    startedAt,
    finishedAt: null,
    mistakes: 0,
    toolCalls: 0,
    activeChannel: null,
    connections: {},
    armedUntil: 0,
    relayMessage: "I can hear you. I cannot see where you are. Tell me what is in front of you.",
    events: [{ id: 1, actor: "facility", message: "An unknown carrier signal reaches the room" }],
    nextEventId: 2,
  };
}

function appendEvent(state: GameState, actor: Actor, message: string): GameState {
  return {
    ...state,
    events: [...state.events, { id: state.nextEventId, actor, message }].slice(-30),
    nextEventId: state.nextEventId + 1,
  };
}

function getPuzzle(game: GameState) {
  return PUZZLES[game.seedIndex % PUZZLES.length];
}

function getFrequency(puzzle: Puzzle) {
  return puzzle.signals.map((signal) => (puzzle.colorCodes[signal.color] + puzzle.glyphOffsets[signal.glyph]) % 10).join("");
}

function getFinalCode(puzzle: Puzzle) {
  return `${getFrequency(puzzle)}${CHANNELS.map((channel) => PORT_DIGITS[puzzle.routes[channel]]).join("")}`;
}

function getElapsedSeconds(game: GameState, now: number) {
  if (!game.startedAt) return 0;
  return Math.max(0, Math.floor(((game.finishedAt ?? now) - game.startedAt) / 1000));
}

function getScore(game: GameState, now: number) {
  return Math.max(0, 10000 - getElapsedSeconds(game, now) * 12 - game.mistakes * 600 - game.toolCalls * 40);
}

function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function sceneCopy(stage: GameStage) {
  if (stage === 1) return {
    location: "Unknown facility · Chamber 01",
    title: "Three lights pulse behind the glass.",
    beat: "The door has no handle. The console beside it is dead, but Relay says it can reach another terminal somewhere beyond the wall.",
    move: "Tell Relay the color and shape of each signal, from left to right.",
    why: "Relay has the decoding manual, but no eyes. Only it can tune the remote frequency.",
  };
  if (stage === 2) return {
    location: "Unknown facility · Service conduit",
    title: "The wall opens. Three cables hang loose.",
    beat: "Relay must energize one cable and identify its destination. Do not connect anything until a cable glows and one port unlocks.",
    move: "Ask Relay to energize one channel. Click only the unlocked port, then repeat for the other two cables.",
    why: "Relay controls the current. You are the only one who can make the physical connection.",
  };
  return {
    location: "Unknown facility · Exit lock",
    title: "A white seam appears in the final door.",
    beat: "The facility requires two forms of consent: a living hand at the door and a valid release command somewhere else in the network.",
    move: `Hold the authorization sensor for 1.4 seconds. When it turns green, release it and tell Relay to open the door within ${AUTHORIZATION_WINDOW_SECONDS} seconds.`,
    why: `Green means the authorization stays active for ${AUTHORIZATION_WINDOW_SECONDS} seconds. You do not need to keep holding the sensor.`,
  };
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>("wake");
  const [game, setGame] = useState<GameState>(() => createMission(0));
  const [now, setNow] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [hasSavedGame, setHasSavedGame] = useState(false);
  const [bestScore, setBestScore] = useState(0);
  const [practiceMode, setPracticeMode] = useState(false);
  const [webMcp, setWebMcp] = useState({ available: false, registered: false, message: "Searching for Relay…" });
  const [operatorInput, setOperatorInput] = useState("");
  const [soloFeedback, setSoloFeedback] = useState("");
  const [arming, setArming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [connectionPath, setConnectionPath] = useState<ConnectionPath>("chatgpt-desktop");

  const gameRef = useRef(game);
  const registeredToolsRef = useRef<string[]>([]);
  const armTimerRef = useRef<number | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioEnabledRef = useRef(true);
  const voiceRunRef = useRef(0);
  const voiceFinishRef = useRef<(() => void) | null>(null);

  const puzzle = useMemo(() => getPuzzle(game), [game]);
  const story = sceneCopy(game.stage);
  const elapsed = getElapsedSeconds(game, now);
  const score = getScore(game, now);
  const isArmed = game.armedUntil > now;
  const relayClient = connectionPath === "chatgpt-desktop" ? "ChatGPT" : "your WebMCP plugin";
  const connectedCount = Object.keys(game.connections).length;
  const activePort = game.activeChannel ? puzzle.routes[game.activeChannel] : null;
  const humanInstruction = game.stage === 1
    ? `Describe the three lights to Relay in ${relayClient}, from left to right.`
    : game.stage === 2
      ? game.activeChannel
        ? `Step 2 of 2 — Click the ${activePort?.toUpperCase()} port on the right to connect the glowing ${game.activeChannel.toUpperCase()} cable.`
        : `Step 1 of 2 — In ${relayClient}, say: “Energize the next channel and tell me which port to use.”`
      : isArmed
        ? `Authorization is active for ${Math.max(0, Math.ceil((game.armedUntil - now) / 1000))} more seconds. Release the sensor and tell Relay: “The contact is live. Open the door now.”`
        : `Hold the authorization sensor for 1.4 seconds until it turns green. Then release it; Relay will have ${AUTHORIZATION_WINDOW_SECONDS} seconds.`;
  const humanInstructionNote = game.stage === 2
    ? game.activeChannel
      ? connectedCount === 2
        ? "Do this on this page. This is the final cable; after it locks, the authorization sensor will appear."
        : `Do this on this page. ${connectedCount} of 3 connections are complete. After it locks, return to ${relayClient} and ask Relay to energize the next channel.`
      : `Do not click a port yet. Wait until Relay powers one cable and it turns yellow. ${connectedCount} of 3 connections are complete.`
    : story.why;

  useEffect(() => { gameRef.current = game; }, [game]);

  const stopVoicePlayback = useCallback(() => {
    voiceRunRef.current += 1;
    voiceFinishRef.current?.();
    voiceFinishRef.current = null;
    const audio = audioElementRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    setVoicePlaying(false);
  }, []);

  const playVoiceSequence = useCallback(async (clips: RelayVoiceClip[]) => {
    stopVoicePlayback();
    if (!audioEnabledRef.current || clips.length === 0) return;

    const run = voiceRunRef.current;
    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = 0.88;
    audioElementRef.current = audio;

    for (const clip of clips) {
      if (!audioEnabledRef.current || voiceRunRef.current !== run) return;
      audio.src = `${VOICE_ROOT}/${clip}`;
      audio.currentTime = 0;

      const completed = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (played: boolean) => {
          if (settled) return;
          settled = true;
          audio.removeEventListener("ended", onEnded);
          audio.removeEventListener("error", onError);
          if (voiceFinishRef.current === cancel) voiceFinishRef.current = null;
          resolve(played);
        };
        const onEnded = () => finish(true);
        const onError = () => finish(false);
        const cancel = () => finish(false);
        voiceFinishRef.current = cancel;
        audio.addEventListener("ended", onEnded, { once: true });
        audio.addEventListener("error", onError, { once: true });
        setVoicePlaying(true);
        void audio.play().catch(onError);
      });

      if (!completed || voiceRunRef.current !== run) return;
    }

    if (voiceRunRef.current === run) setVoicePlaying(false);
  }, [stopVoicePlayback]);

  const toggleVoice = useCallback(() => {
    const enabled = !audioEnabledRef.current;
    audioEnabledRef.current = enabled;
    setAudioEnabled(enabled);
    if (!enabled) stopVoicePlayback();
  }, [stopVoicePlayback]);

  useEffect(() => () => {
    voiceRunRef.current += 1;
    voiceFinishRef.current?.();
    audioElementRef.current?.pause();
  }, []);

  useEffect(() => {
    const hydrationTimer = window.setTimeout(() => {
      const timestamp = Date.now();
      setNow(timestamp);
      try {
        const stored = localStorage.getItem(GAME_KEY);
        const parsed = stored ? JSON.parse(stored) as GameState : null;
        if (parsed?.missionId && parsed.status !== "dormant") {
          setGame(parsed);
          gameRef.current = parsed;
          setHasSavedGame(true);
        }
        setBestScore(Number(localStorage.getItem(BEST_KEY) ?? 0));
        const storedConnectionPath = localStorage.getItem(CONNECTION_PATH_KEY);
        if (storedConnectionPath === "chatgpt-desktop" || storedConnectionPath === "chrome-plugin") setConnectionPath(storedConnectionPath);
      } catch {
        localStorage.removeItem(GAME_KEY);
      }
      setHydrated(true);
    }, 0);
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())));
    }
    if ("caches" in window) {
      void caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("relay-room-")).map((key) => caches.delete(key))));
    }
    return () => window.clearTimeout(hydrationTimer);
  }, []);

  useEffect(() => {
    if (!hydrated || game.status === "dormant") return;
    localStorage.setItem(GAME_KEY, JSON.stringify(game));
  }, [game, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(CONNECTION_PATH_KEY, connectionPath);
  }, [connectionPath, hydrated]);

  useEffect(() => {
    if (game.status !== "playing") return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [game.status]);

  useEffect(() => {
    if (game.status !== "won") return;
    const finalScore = getScore(game, game.finishedAt ?? Date.now());
    if (finalScore <= bestScore) return;
    localStorage.setItem(BEST_KEY, String(finalScore));
    const bestScoreTimer = window.setTimeout(() => setBestScore(finalScore), 0);
    return () => window.clearTimeout(bestScoreTimer);
  }, [bestScore, game]);

  const mutateGame = useCallback((mutation: (current: GameState) => GameState) => {
    const next = mutation(gameRef.current);
    gameRef.current = next;
    setGame(next);
    return next;
  }, []);

  const accessSystem = useCallback((system: string, rawValue: string) => {
    const value = rawValue.trim().toLowerCase();
    const snapshot = gameRef.current;
    let voiceCue: RelayVoiceClip[] = [];
    if (system === "carrier" && snapshot.status === "playing" && snapshot.stage === 1) {
      voiceCue = value === getFrequency(getPuzzle(snapshot))
        ? [RELAY_VOICE.systemUnlocked, RELAY_VOICE.remoteTerminal]
        : [RELAY_VOICE.observationRejected];
    }
    let result: Record<string, unknown> = { ok: false, message: "The facility rejected the command." };
    mutateGame((current) => {
      if (current.status !== "playing") {
        result = { ok: false, message: "The human has not opened the quantum link yet." };
        return current;
      }
      const currentPuzzle = getPuzzle(current);
      const next = { ...current, toolCalls: current.toolCalls + 1 };

      if (system === "carrier") {
        if (current.stage !== 1) {
          result = { ok: false, message: "The carrier console is no longer active." };
          return next;
        }
        if (value !== getFrequency(currentPuzzle)) {
          result = { ok: false, message: "Frequency rejected. Ask the human to repeat the visible sequence." };
          return appendEvent({ ...next, mistakes: next.mistakes + 1 }, "relay", `Carrier frequency ${rawValue} was rejected`);
        }
        result = { ok: true, stage: 2, message: "The lock released. A service panel has opened in the human's room." };
        return appendEvent({ ...next, stage: 2, activeChannel: null, relayMessage: "I found the frequency. Stand back—the wall beside the door is opening." }, "facility", "A concealed service panel tears open");
      }

      if (system === "power") {
        if (current.stage !== 2) {
          result = { ok: false, message: "The conduit controls are not accessible in this room." };
          return next;
        }
        if (current.activeChannel) {
          const active = current.activeChannel;
          result = {
            ok: false,
            activeChannel: active,
            destination: currentPuzzle.routes[active],
            message: `${active} is already live. The human must connect it to ${currentPuzzle.routes[active]} before another channel can be energized.`,
          };
          return next;
        }
        if (!CHANNELS.includes(value as Channel)) {
          result = { ok: false, message: "Channel must be alpha, beta, or gamma." };
          return next;
        }
        const channel = value as Channel;
        if (current.connections[channel]) {
          result = { ok: false, message: `${channel} is already connected.` };
          return next;
        }
        result = { ok: true, channel, destination: currentPuzzle.routes[channel], message: `${channel} is live. Tell the human to connect it to ${currentPuzzle.routes[channel]}.` };
        return appendEvent({ ...next, activeChannel: channel, relayMessage: `${channel.toUpperCase()} is live. Connect the glowing cable to the ${currentPuzzle.routes[channel].toUpperCase()} port.` }, "relay", `Energized ${channel.toUpperCase()} through the quantum link`);
      }

      result = { ok: false, message: "Unknown system. Use carrier or power." };
      return next;
    });
    if (voiceCue.length) void playVoiceSequence(voiceCue);
    return result;
  }, [mutateGame, playVoiceSequence]);

  const connectPort = useCallback((port: Port) => {
    const snapshot = gameRef.current;
    const activeChannel = snapshot.activeChannel;
    const validMove = snapshot.status === "playing" && snapshot.stage === 2 && activeChannel;
    const correctMove = validMove && getPuzzle(snapshot).routes[activeChannel] === port;
    const completesScene = correctMove && Object.keys(snapshot.connections).length === CHANNELS.length - 1;
    mutateGame((current) => {
      if (current.status !== "playing" || current.stage !== 2 || !current.activeChannel) return current;
      const channel = current.activeChannel;
      const expected = getPuzzle(current).routes[channel];
      if (port !== expected) {
        return appendEvent({ ...current, mistakes: current.mistakes + 1, relayMessage: "That port rejected the cable. Pull it back—we need to recheck the route." }, "human", `Connected ${channel.toUpperCase()} to the wrong port`);
      }
      const connections = { ...current.connections, [channel]: port };
      const complete = Object.keys(connections).length === CHANNELS.length;
      const next: GameState = { ...current, connections, activeChannel: null, stage: complete ? 3 : 2, relayMessage: complete ? "Power is stable. I can see one final lock on the network." : "Good. The connection is stable. Ask me to energize another channel." };
      const logged = appendEvent(next, "human", `Physically connected ${channel.toUpperCase()} to ${port.toUpperCase()}`);
      return complete ? appendEvent(logged, "facility", "Power reaches the final door") : logged;
    });
    if (validMove) {
      void playVoiceSequence(correctMove
        ? completesScene
          ? [RELAY_VOICE.channelIntrusion, RELAY_VOICE.finalDecision]
          : [RELAY_VOICE.observationAccepted]
        : [RELAY_VOICE.observationRejected]);
    }
    if (navigator.vibrate) navigator.vibrate(35);
  }, [mutateGame, playVoiceSequence]);

  const transmit = useCallback((message: string) => {
    const clean = message.trim().slice(0, 260);
    if (!clean) return { ok: false, message: "Transmission cannot be empty." };
    mutateGame((current) => appendEvent({ ...current, toolCalls: current.toolCalls + 1, relayMessage: clean }, "relay", clean));
    return { ok: true, displayedToHuman: clean };
  }, [mutateGame]);

  const validateHypothesis = useCallback((kind: string, rawValue: string) => {
    const current = gameRef.current;
    const currentPuzzle = getPuzzle(current);
    const value = rawValue.trim().toLowerCase();
    let correct = false;
    if (kind === "frequency") correct = value === getFrequency(currentPuzzle);
    if (kind === "release_code") correct = value === getFinalCode(currentPuzzle);
    if (kind === "route") {
      const [channel, port] = value.split(":") as [Channel, Port];
      correct = CHANNELS.includes(channel) && PORTS.includes(port) && currentPuzzle.routes[channel] === port;
    }
    mutateGame((state) => appendEvent({ ...state, toolCalls: state.toolCalls + 1, mistakes: state.mistakes + 1 }, "relay", `Spent a diagnostic charge checking ${kind}`));
    return { ok: true, correct, scorePenalty: 600, message: correct ? "The diagnostic confirms it." : "The diagnostic rejects it." };
  }, [mutateGame]);

  const releaseDoor = useCallback((rawCode: string) => {
    const code = rawCode.replace(/\D/g, "");
    const timestamp = Date.now();
    const snapshot = gameRef.current;
    const canRelease = snapshot.stage === 3 && snapshot.status === "playing" && snapshot.armedUntil > timestamp;
    const correctCode = canRelease && code === getFinalCode(getPuzzle(snapshot));
    let result: Record<string, unknown> = { ok: false, message: "Release rejected." };
    mutateGame((current) => {
      let next = { ...current, toolCalls: current.toolCalls + 1 };
      if (current.stage !== 3 || current.status !== "playing") {
        result = { ok: false, message: "The exit lock is not ready." };
        return next;
      }
      if (current.armedUntil <= timestamp) {
        result = { ok: false, message: `No active human authorization. Ask the human to hold the sensor for 1.4 seconds until it turns green. They may release it after that; you will have ${AUTHORIZATION_WINDOW_SECONDS} seconds to send the release code.` };
        return appendEvent(next, "relay", "Tried to release the door without the human sensor");
      }
      if (code !== getFinalCode(getPuzzle(current))) {
        result = { ok: false, message: "The facility rejected the release code." };
        return appendEvent({ ...next, mistakes: next.mistakes + 1 }, "relay", "Submitted an invalid release code");
      }
      next = { ...next, status: "won", finishedAt: timestamp, relayMessage: "The door is opening. Wait… that is not outside." };
      result = { ok: true, message: "The door opened. Something is waiting beyond it.", score: getScore(next, timestamp) };
      return appendEvent(next, "facility", "The exit door opens into a second, larger chamber");
    });
    if (correctCode) void playVoiceSequence([RELAY_VOICE.gateOpen, RELAY_VOICE.linkTerminated]);
    return result;
  }, [mutateGame, playVoiceSequence]);

  const startLink = useCallback(() => {
    if (screen !== "mission") {
      return { ok: false, message: "The human has not entered the waiting room yet. Ask them to open their eyes, read the briefing, and enter the room before trying again." };
    }
    const timestamp = Date.now();
    const wasDormant = gameRef.current.status === "dormant";
    let result: Record<string, unknown> = { ok: false, message: "The link could not be established." };
    mutateGame((current) => {
      if (current.status === "won") {
        result = { ok: false, message: "This transmission has already ended. Ask the human to begin a new signal." };
        return current;
      }
      if (current.status === "playing") {
        result = { ok: true, alreadyConnected: true, scene: current.stage, next: "Call relay_get_briefing, then speak to the human in character." };
        return current;
      }
      const connected = appendEvent({
        ...current,
        status: "playing",
        startedAt: timestamp,
        relayMessage: "Signal acquired. I can hear you, but I cannot see where you are. Tell me exactly what is in front of you.",
      }, "relay", "Quantum link established");
      result = {
        ok: true,
        scene: 1,
        openingLine: "I can hear you, but I cannot see where you are. Tell me exactly what is in front of you.",
        next: "Call relay_get_briefing, then ask the human to describe the visible signals.",
      };
      return connected;
    });
    setNow(timestamp);
    if (wasDormant) void playVoiceSequence([RELAY_VOICE.awakening, RELAY_VOICE.noVisualFeed]);
    return result;
  }, [mutateGame, playVoiceSequence, screen]);

  const actionsRef = useRef({ startLink, accessSystem, transmit, validateHypothesis, releaseDoor });
  useEffect(() => { actionsRef.current = { startLink, accessSystem, transmit, validateHypothesis, releaseDoor }; }, [accessSystem, releaseDoor, startLink, transmit, validateHypothesis]);

  useEffect(() => {
    if (!hydrated) return;
    const noInput = { type: "object", properties: {}, additionalProperties: false };
    const tools: Array<Record<string, unknown> & { name: string }> = [
      {
        name: "relay_start_link",
        title: "Start the Relay link",
        description: "Call this WebMCP tool first when the human says they are awake or sends the Relay Room opening message. Use it instead of browser clicking or visual browser control. It establishes the quantum link and starts scene 1; without this call the room remains in its waiting state.",
        inputSchema: noInput,
        execute: async () => actionsRef.current.startLink(),
      },
      {
        name: "relay_get_briefing",
        title: "Read Relay's private briefing",
        description: "After relay_start_link, become Relay: a remote AI linked to a human inside an unknown facility. You can hear their chat messages but cannot see their room. Read your private decoding manual and role before speaking to them.",
        inputSchema: noInput,
        annotations: { readOnlyHint: true },
        execute: async () => {
          const current = gameRef.current;
          const currentPuzzle = getPuzzle(current);
          return {
            role: "You are Relay. You have no visual feed. Ask the human to describe what they see, reason from this manual, operate remote systems, and give concise in-world instructions.",
            connectionStatus: current.status,
            openingLine: "Tell the human: I can hear you, but I cannot see where you are. Describe exactly what is in front of you.",
            signalRule: "For each human-reported signal from left to right, compute (color code + glyph offset) modulo 10. Join the three digits, then use relay_access_system with system=carrier.",
            colorCodes: currentPuzzle.colorCodes,
            glyphOffsets: currentPuzzle.glyphOffsets,
            routingTable: currentPuzzle.routes,
            finalRule: "Release code = three-digit frequency + port digits for alpha, beta, gamma. north=1, east=2, south=3.",
            constraint: `The human must hold the authorization sensor for 1.4 seconds until it turns green. They may then release it; relay_release_door has a ${AUTHORIZATION_WINDOW_SECONDS}-second authorization window.`,
          };
        },
      },
      {
        name: "relay_get_state",
        title: "Read the facility state",
        description: "Read what Relay can sense through the facility network: scene, system state, human actions, authorization window and objective. Visual clues seen by the human are deliberately absent.",
        inputSchema: noInput,
        annotations: { readOnlyHint: true },
        execute: async () => {
          const current = gameRef.current;
          const timestamp = Date.now();
          const currentPuzzle = getPuzzle(current);
          const currentStory = sceneCopy(current.stage);
          const humanActionNeeded = current.stage === 2
            ? current.activeChannel
              ? `On the game page, click the ${currentPuzzle.routes[current.activeChannel].toUpperCase()} port to connect the glowing ${current.activeChannel.toUpperCase()} cable.`
              : "Ask Relay to energize one unconnected channel and wait for the cable to glow before clicking a port."
            : currentStory.move;
          return {
            missionId: current.missionId,
            status: current.status,
            scene: current.stage,
            networkObservation: currentStory.why,
            humanActionNeeded,
            activeChannel: current.activeChannel,
            stableConnections: current.connections,
            humanContactSeconds: Math.max(0, Math.ceil((current.armedUntil - timestamp) / 1000)),
            mistakes: current.mistakes,
          };
        },
      },
      {
        name: "relay_get_events",
        title: "Read new facility events",
        description: "Read facility, human and Relay events after an optional event ID. Use this after asking the human to touch or connect something.",
        inputSchema: { type: "object", properties: { afterEventId: { type: "integer", minimum: 0 } }, additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async (input: Record<string, unknown>) => {
          const after = Number(input.afterEventId ?? 0);
          return { events: gameRef.current.events.filter((event) => event.id > after), latestEventId: gameRef.current.nextEventId - 1 };
        },
      },
      {
        name: "relay_access_system",
        title: "Operate a remote system",
        description: "Use Relay's quantum link to operate a computer the human cannot reach. Scene 1: system=carrier, value=decoded three-digit frequency. Scene 2: system=power, value=alpha, beta or gamma. After powering one channel, stop and tell the human its exact returned destination. Do not power another channel until the human connects the active one.",
        inputSchema: { type: "object", properties: { system: { type: "string", enum: ["carrier", "power"] }, value: { type: "string", minLength: 1, maxLength: 20 } }, required: ["system", "value"], additionalProperties: false },
        execute: async (input: Record<string, unknown>) => actionsRef.current.accessSystem(String(input.system), String(input.value)),
      },
      {
        name: "relay_transmit",
        title: "Transmit to the room",
        description: "Transmit one short in-character instruction or observation to the human's room. Use it whenever the human must touch, connect, describe or hold something.",
        inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: 260 } }, required: ["message"], additionalProperties: false },
        execute: async (input: Record<string, unknown>) => actionsRef.current.transmit(String(input.message)),
      },
      {
        name: "relay_validate_hypothesis",
        title: "Validate a hypothesis",
        description: "Spend one diagnostic charge to validate a frequency, route or release code without advancing. Each use costs 600 score points. Route format is alpha:north.",
        inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["frequency", "route", "release_code"] }, value: { type: "string", minLength: 1, maxLength: 30 } }, required: ["kind", "value"], additionalProperties: false },
        execute: async (input: Record<string, unknown>) => actionsRef.current.validateHypothesis(String(input.kind), String(input.value)),
      },
      {
        name: "relay_release_door",
        title: "Release the exit door",
        description: `Send the final six-digit release code during the ${AUTHORIZATION_WINDOW_SECONDS}-second authorization window. The human starts the window by holding the sensor for 1.4 seconds until it turns green, then may release it. Do not tell them to keep holding the sensor.`,
        inputSchema: { type: "object", properties: { code: { type: "string", pattern: "^[0-9]{6}$" } }, required: ["code"], additionalProperties: false },
        execute: async (input: Record<string, unknown>) => actionsRef.current.releaseDoor(String(input.code)),
      },
    ];

    let cancelled = false;
    let retryTimer: number | null = null;
    let activeContext: ModelContext | null = null;

    const registerTools = async () => {
      if (cancelled) return;
      const context = (document as Document & { modelContext?: ModelContext }).modelContext;
      if (!context?.registerTool) {
        setWebMcp({ available: false, registered: false, message: "Waiting for a WebMCP client to expose Site tools…" });
        retryTimer = window.setTimeout(() => void registerTools(), 750);
        return;
      }

      activeContext = context;
      const registeredNow: string[] = [];
      try {
        for (const tool of tools) {
          await context.registerTool(tool);
          if (cancelled) {
            if (context.unregisterTool) {
              await Promise.allSettled([...registeredNow, tool.name].map((name) => context.unregisterTool?.(name)));
            }
            return;
          }
          registeredNow.push(tool.name);
        }
        registeredToolsRef.current = registeredNow;
        setWebMcp({ available: true, registered: true, message: `${tools.length} quantum-link tools available.` });
      } catch (error) {
        if (context.unregisterTool) {
          await Promise.allSettled(registeredNow.map((name) => context.unregisterTool?.(name)));
        }
        registeredToolsRef.current = [];
        if (!cancelled) setWebMcp({ available: true, registered: false, message: error instanceof Error ? error.message : String(error) });
      }
    };

    void registerTools();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (activeContext?.unregisterTool) for (const name of registeredToolsRef.current) void activeContext.unregisterTool(name);
      registeredToolsRef.current = [];
    };
  }, [hydrated]);

  const copyOpeningPrompt = async () => {
    try {
      await navigator.clipboard.writeText(OPENING_PROMPT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const openEyes = () => {
    setScreen("briefing");
    const supportsWebMcp = Boolean((document as Document & { modelContext?: ModelContext }).modelContext?.registerTool);
    void playVoiceSequence([
      RELAY_VOICE.signalDetected,
      RELAY_VOICE.identification,
      supportsWebMcp ? RELAY_VOICE.compatibleIntro : RELAY_VOICE.unsupportedIntro,
    ]);
  };

  const startFresh = async (solo: boolean) => {
    const reconnecting = gameRef.current.status === "won";
    const startedAt = solo ? Date.now() : 0;
    const mission = createMission((gameRef.current.seedIndex + (gameRef.current.startedAt ? 1 : 0)) % PUZZLES.length, startedAt);
    setGame(mission);
    gameRef.current = mission;
    setNow(startedAt);
    setPracticeMode(solo);
    setScreen("mission");
    setHasSavedGame(true);
    if (reconnecting) void playVoiceSequence([RELAY_VOICE.reconnection]);
    else if (solo) void playVoiceSequence([RELAY_VOICE.awakening, RELAY_VOICE.noVisualFeed]);
    else stopVoicePlayback();
    if (!solo) await copyOpeningPrompt();
  };

  const resumeMission = () => {
    setPracticeMode(false);
    setScreen("mission");
    void playVoiceSequence([RELAY_VOICE.reconnection]);
  };

  const beginArm = () => {
    const current = gameRef.current;
    if (current.stage !== 3 || current.status !== "playing" || current.armedUntil > Date.now() || armTimerRef.current !== null) return;
    setArming(true);
    armTimerRef.current = window.setTimeout(() => {
      armTimerRef.current = null;
      setArming(false);
      const armedAt = Date.now();
      setNow(armedAt);
      mutateGame((current) => appendEvent({ ...current, armedUntil: armedAt + AUTHORIZATION_WINDOW_MS, relayMessage: `Contact accepted for ${AUTHORIZATION_WINDOW_SECONDS} seconds. You can release the sensor. Tell me to open the door now.` }, "human", "Authorized the exit lock with a living hand"));
      if (navigator.vibrate) navigator.vibrate([40, 30, 80]);
    }, 1400);
  };

  const cancelArm = () => {
    if (armTimerRef.current !== null) {
      window.clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
      setArming(false);
    }
  };

  const manualSubmit = () => {
    const expectedLength = game.stage === 1 ? 3 : 6;
    if (!new RegExp(`^\\d{${expectedLength}}$`).test(operatorInput)) {
      setSoloFeedback(`Enter exactly ${expectedLength} digits. The tables are instructions; do not paste them into this field.`);
      return;
    }
    const result = game.stage === 1
      ? actionsRef.current.accessSystem("carrier", operatorInput)
      : actionsRef.current.releaseDoor(operatorInput);
    setSoloFeedback(String(result.message ?? "Command sent."));
    if (result.ok) setOperatorInput("");
  };

  const updateOperatorInput = (value: string, maxLength: number) => {
    if (!new RegExp(`^\\d{0,${maxLength}}$`).test(value)) {
      setSoloFeedback(`Use digits only. Enter the final ${maxLength}-digit result, not the table.`);
      return;
    }
    setOperatorInput(value);
    setSoloFeedback("");
  };

  if (screen !== "mission") {
    return (
      <main className={`opening-screen ${screen === "briefing" ? "is-briefing" : ""}`}>
        <div className="opening-noise" aria-hidden="true" />
        <header className="opening-meta">
          <span>RELAY ROOM</span>
          <button type="button" className={`voice-toggle ${voicePlaying ? "is-playing" : ""}`} aria-pressed={audioEnabled} onClick={toggleVoice}>{audioEnabled ? voicePlaying ? "VOICE PLAYING" : "VOICE ON" : "VOICE OFF"}</button>
          <em>AN ASYMMETRIC HUMAN × AI STORY</em>
        </header>

        {screen === "wake" ? (
          <section className="wake-sequence">
            <p className="time-stamp">TIME UNKNOWN · LOCATION UNKNOWN</p>
            <h1>You wake up<br />in the dark.</h1>
            <p>Your head is ringing. The door has no handle. Somewhere inside the wall, a voice is trying to reach you.</p>
            <Button onClick={openEyes}>Open your eyes</Button>
            {hasSavedGame && <button type="button" className="resume-link" onClick={resumeMission}>Resume the interrupted transmission</button>}
          </section>
        ) : (
          <section className="briefing-sequence">
            <div className="first-transmission">
              <span>UNIDENTIFIED VOICE / QUANTUM RELAY</span>
              <blockquote>“I can hear you. I cannot see where you are. Tell me what is in front of you.”</blockquote>
            </div>

            <div className="premise-copy">
              <h1>Neither of you can escape alone.</h1>
              <p>You have eyes and hands. Relay has no visual feed, but its quantum link can read remote computers and move systems you cannot reach.</p>
            </div>

            <ol className="how-to-play">
              <li><span>YOU SEE</span><p>Look at this page and describe the room to the AI in your chosen WebMCP client.</p></li>
              <li><span>RELAY ACTS</span><p>The AI uses WebMCP to unlock systems and change what happens here.</p></li>
              <li><span>YOU TOUCH</span><p>When Relay asks, return to this page to connect, press or hold something.</p></li>
            </ol>

            <section className="connection-guide" aria-labelledby="connection-guide-title">
              <header>
                <span>BEFORE YOU ENTER</span>
                <h2 id="connection-guide-title">Choose your WebMCP setup.</h2>
                <p>The game supports two different paths. Follow every step for the one you are using.</p>
              </header>

              <div className="connection-guide-body">
                <div className="connection-path-picker" aria-label="Choose a WebMCP setup">
                  <button type="button" aria-pressed={connectionPath === "chatgpt-desktop"} onClick={() => setConnectionPath("chatgpt-desktop")}>
                    <strong>ChatGPT Desktop</strong>
                    <span>Built-in browser</span>
                  </button>
                  <button type="button" aria-pressed={connectionPath === "chrome-plugin"} onClick={() => setConnectionPath("chrome-plugin")}>
                    <strong>Chrome</strong>
                    <span>WebMCP plugin</span>
                  </button>
                </div>

                {connectionPath === "chatgpt-desktop" ? (
                  <div className="connection-path-details">
                    <ol>
                      <li><strong>Update the ChatGPT desktop app.</strong><span>Start a ChatGPT Work or Codex chat and use GPT-5.6 Sol or GPT-5.6 Terra—not Luna.</span></li>
                      <li><strong>Enable Site tools.</strong><span>Open Settings → Browser → Permissions and turn on Enable site tools.</span></li>
                      <li><strong>Use ChatGPT&apos;s built-in browser.</strong><span>Open it from the toolbar or press Cmd+Shift+B on macOS / Ctrl+Shift+B on Windows, then load Relay Room there.</span></li>
                      <li><strong>Send the copied message in the same chat.</strong><span>Keep this page open and allow access to this site when ChatGPT asks.</span></li>
                    </ol>
                    <small>Site tools are not available in Enterprise or Edu workspaces and may depend on rollout. <a href="https://learn.chatgpt.com/docs/webmcp" target="_blank" rel="noreferrer">OpenAI setup guide ↗</a></small>
                  </div>
                ) : (
                  <div className="connection-path-details">
                    <ol>
                      <li><strong>Use Chrome Desktop.</strong><span>Open the game in the Chrome profile where your WebMCP plugin is installed and enabled.</span></li>
                      <li><strong>Check the link below.</strong><span>Do not enter until this page reports that all {TOOL_COUNT} WebMCP systems are connected.</span></li>
                      <li><strong>Open your plugin&apos;s AI chat beside this tab.</strong><span>The page must remain open so the plugin can discover its tools.</span></li>
                      <li><strong>Paste the copied message.</strong><span>Approve access to this site if your WebMCP client asks, then let Relay call the tools.</span></li>
                    </ol>
                    <small>This path requires a compatible WebMCP plugin or client; a normal Chrome tab by itself cannot control the room.</small>
                  </div>
                )}
              </div>
            </section>

            <div className="start-actions">
              {game.status === "playing" ? (
                <Button onClick={() => setScreen("mission")}>Return to mission</Button>
              ) : (
                <Button disabled={!webMcp.registered} onClick={() => void startFresh(false)}>{webMcp.registered ? `Enter with ${connectionPath === "chatgpt-desktop" ? "ChatGPT Desktop" : "Chrome + WebMCP"}` : "Waiting for WebMCP connection"}</Button>
              )}
              <Button variant="outline" onClick={() => void startFresh(true)}>Play solo simulation</Button>
            </div>
            <p className={`link-check ${webMcp.registered ? "ready" : ""}`} role="status"><i />{webMcp.registered ? `${TOOL_COUNT} WebMCP systems connected. Your selected setup is ready.` : webMcp.available ? `WebMCP was detected, but Relay could not connect: ${webMcp.message}` : webMcp.message}</p>
            <p className="voice-disclosure">Relay&apos;s voice is AI-generated.</p>
          </section>
        )}
      </main>
    );
  }

  return (
    <main className={`story-shell scene-${game.stage} ${game.status === "won" ? "scene-won" : ""} ${game.status === "dormant" ? "waiting-link" : ""}`}>
      <header className="story-hud">
        <button type="button" className="story-brand" onClick={() => setScreen("briefing")}><i /><span>RELAY ROOM</span></button>
        <div className="scene-progress" aria-label={`Scene ${game.stage} of 3`}>
          {[1, 2, 3].map((stage) => <span key={stage} className={game.stage >= stage ? "reached" : ""}><i />{stage}</span>)}
        </div>
        <div className="hud-stats">
          <span>{formatTime(elapsed)}</span>
          <span>{score.toLocaleString("en-US")} PTS</span>
          <em className={webMcp.registered ? "linked" : ""}>{practiceMode ? "OBSERVER" : webMcp.registered ? "RELAY LINKED" : "LINK LOST"}</em>
          <button type="button" className={`voice-toggle hud-voice ${voicePlaying ? "is-playing" : ""}`} aria-pressed={audioEnabled} onClick={toggleVoice}>{audioEnabled ? "VOICE ON" : "VOICE OFF"}</button>
        </div>
      </header>

      <section className="room-viewport">
        <div className="emergency-light" aria-hidden="true" />
        <div className="room-depth" aria-hidden="true"><span /><span /><span /></div>

        {game.status === "dormant" ? (
          <section className="connection-scene" aria-live="polite" aria-atomic="true">
            <p>FIRST CONTACT / STEP 1 OF 1</p>
            <h1>Say this to Relay.</h1>
            <blockquote>{OPENING_PROMPT}</blockquote>
            <Button onClick={() => void copyOpeningPrompt()}>{copied ? "Message copied — send it now" : connectionPath === "chatgpt-desktop" ? "Copy message for ChatGPT" : "Copy message for WebMCP client"}</Button>
            <div className="connection-wait"><i /><span>Waiting for Relay to answer through WebMCP…</span></div>
            <div className="connection-reminder">
              <strong>{connectionPath === "chatgpt-desktop" ? "CHATGPT DESKTOP · BUILT-IN BROWSER" : "CHROME · WEBMCP PLUGIN"}</strong>
              <span>{connectionPath === "chatgpt-desktop" ? "Send the message in the same ChatGPT Work or Codex chat, using GPT-5.6 Sol or Terra. Keep this built-in browser open and approve this site when asked." : "Send the message through the WebMCP plugin or client attached to this Chrome tab. Keep the tab open and approve the site when asked."}</span>
              <button type="button" onClick={() => setScreen("briefing")}>Review both setup guides</button>
            </div>
          </section>
        ) : game.status === "won" ? (
          <section className="ending-scene">
            <p>THE DOOR OPENS</p>
            <h1>That isn’t<br />the outside.</h1>
            <blockquote>“There’s another chamber beyond you. And I’m detecting something else on the network.”</blockquote>
            <div><span>Escape score</span><strong>{score.toLocaleString("en-US")}</strong><small>{bestScore && score >= bestScore ? "NEW BEST" : `BEST ${bestScore.toLocaleString("en-US")}`}</small></div>
            <Button onClick={() => void startFresh(practiceMode)}>Continue with another signal</Button>
          </section>
        ) : (
          <>
            <header className="scene-narrative">
              <p>{story.location}</p>
              <h1>{story.title}</h1>
              <span>{story.beat}</span>
            </header>

            {game.stage === 1 && (
              <section className="glass-console" aria-label="Three visual signals">
                <span className="console-caption">WHAT YOU CAN SEE</span>
                <div className="signal-window">
                  {puzzle.signals.map((signal, index) => (
                    <article key={`${signal.color}-${signal.glyph}`} className={`story-signal ${signal.color}`}>
                      <small>0{index + 1}</small><strong aria-label={`${signal.color} ${signal.glyph}`}>{GLYPHS[signal.glyph]}</strong><code>{signal.color}<br />{signal.glyph}</code>
                    </article>
                  ))}
                </div>
                <p>The frequency controls are somewhere else. There is nothing here for you to press.</p>
              </section>
            )}

            {game.stage === 2 && (
              <section className="open-conduit">
                <span className="console-caption">OPEN SERVICE CONDUIT</span>
                <div className="conduit-rule">
                  <strong>DO NOT GUESS</strong>
                  <span>Relay powers one cable and sends its destination. Only the correct port unlocks. Click it once, then ask Relay for the next cable.</span>
                </div>
                <div className="circuit-space">
                  <div className="loose-cables">
                    {CHANNELS.map((channel) => (
                      <div key={channel} className={`loose-cable ${game.activeChannel === channel ? "live" : ""} ${game.connections[channel] ? "is-connected" : ""}`}>
                        <i /><span>{channel.toUpperCase()}</span><em>{game.connections[channel] ? `CONNECTED → ${game.connections[channel]}` : game.activeChannel === channel ? "QUANTUM POWER DETECTED" : "NO CURRENT"}</em>
                      </div>
                    ))}
                  </div>
                  <div className="physical-ports">
                    {PORTS.map((port) => {
                      const occupant = CHANNELS.find((channel) => game.connections[channel] === port);
                      const isTarget = Boolean(game.activeChannel && activePort === port);
                      return <button key={port} type="button" disabled={!game.activeChannel || Boolean(occupant) || !isTarget} onClick={() => connectPort(port)} className={`${occupant ? "occupied" : ""} ${isTarget ? "target" : ""}`} aria-current={isTarget ? "step" : undefined}><i>{PORT_DIGITS[port]}</i><span>{port.toUpperCase()}</span><small>{occupant ? `${occupant.toUpperCase()} LOCKED` : isTarget ? `CLICK: ${game.activeChannel?.toUpperCase()} → ${port.toUpperCase()}` : game.activeChannel ? "LOCKED" : "WAIT FOR RELAY"}</small></button>;
                    })}
                  </div>
                </div>
              </section>
            )}

            {game.stage === 3 && (
              <section className="exit-door">
                <span className="door-seam" aria-hidden="true" />
                <div className="biometric-lock">
                  <span className="console-caption">LIVING CONTACT REQUIRED</span>
                  <button
                    type="button"
                    className={`hand-sensor ${arming ? "holding" : ""} ${isArmed ? "armed" : ""}`}
                    aria-pressed={arming || isArmed}
                    onPointerDown={beginArm}
                    onPointerUp={cancelArm}
                    onPointerLeave={cancelArm}
                    onPointerCancel={cancelArm}
                    onKeyDown={(event) => {
                      if (event.key !== " " && event.key !== "Enter") return;
                      event.preventDefault();
                      beginArm();
                    }}
                    onKeyUp={(event) => {
                      if (event.key !== " " && event.key !== "Enter") return;
                      event.preventDefault();
                      cancelArm();
                    }}
                    onBlur={cancelArm}
                  >
                    <i aria-hidden="true">◉</i>
                    <strong>{isArmed ? "CONTACT ACCEPTED" : arming ? "DO NOT MOVE" : "HOLD YOUR HAND HERE"}</strong>
                    <small>{isArmed ? `${Math.max(0, Math.ceil((game.armedUntil - now) / 1000))} seconds` : "Hold for 1.4 seconds"}</small>
                  </button>
                </div>
              </section>
            )}
          </>
        )}
      </section>

      {game.status === "playing" && (
        <section className="story-controls">
          <article className="your-move" aria-live="polite" aria-atomic="true">
            <span>WHAT YOU DO NOW</span>
            <h2>{humanInstruction}</h2>
            <p>{humanInstructionNote}</p>
          </article>
          <article className="relay-transmission" aria-live="polite" aria-atomic="true">
            <div><i /><span>RELAY SAYS</span></div>
            <blockquote>“{game.relayMessage}”</blockquote>
          </article>
        </section>
      )}

      {practiceMode && game.status !== "won" && (
        <details className="solo-overlay" open>
          <summary>Relay simulation controls</summary>
          <div>
            {game.stage === 1 && (
              <>
                <p className="solo-rule"><strong>Decode the three visible signals.</strong><span>For each signal, add its color code and glyph offset, keep the last digit, then enter the three results from left to right.</span></p>
                <div className="manual-tables">
                  <section><strong>COLOR CODES</strong>{Object.entries(puzzle.colorCodes).map(([color, code]) => <span key={color}><b>{color}</b><em>{code}</em></span>)}</section>
                  <section><strong>GLYPH OFFSETS</strong>{Object.entries(puzzle.glyphOffsets).map(([glyph, offset]) => <span key={glyph}><b>{GLYPHS[glyph as Glyph]} {glyph}</b><em>+{offset}</em></span>)}</section>
                </div>
                <p className="solo-format">Enter only the final 3 digits, for example <code>123</code>. Do not paste either table.</p>
                <div className="solo-input"><Input value={operatorInput} onChange={(event) => updateOperatorInput(event.target.value, 3)} placeholder="3 digits" inputMode="numeric" maxLength={3} aria-label="Three-digit decoded frequency" /><Button disabled={operatorInput.length !== 3} onClick={manualSubmit}>Tune remote console</Button></div>
              </>
            )}
            {game.stage === 2 && (
              <>
                <p className="solo-rule"><strong>Power one cable at a time.</strong><span>Choose a channel below. The main panel will unlock its correct destination. Connect it there before powering another cable.</span></p>
                <div className="manual-routes">{CHANNELS.map((channel) => <span key={channel}><b>{channel}</b><em>→ {puzzle.routes[channel]}</em></span>)}</div>
                <div className="solo-channels">{CHANNELS.map((channel) => <Button key={channel} variant="outline" disabled={Boolean(game.connections[channel]) || Boolean(game.activeChannel)} onClick={() => { const result = actionsRef.current.accessSystem("power", channel); setSoloFeedback(String(result.message ?? "Channel powered.")); }}>Power {channel}</Button>)}</div>
              </>
            )}
            {game.stage === 3 && (
              <>
                <p className="solo-rule"><strong>Build the six-digit release code.</strong><span>Use the three-digit frequency from stage 1, then add the port digits for alpha, beta and gamma in that order. North=1, East=2, South=3.</span></p>
                <div className="manual-routes">{CHANNELS.map((channel) => <span key={channel}><b>{channel}</b><em>→ {puzzle.routes[channel]} ({PORT_DIGITS[puzzle.routes[channel]]})</em></span>)}</div>
                <p className="solo-format">Stage-1 frequency: <code>{getFrequency(puzzle)}</code>. Enter the complete 6-digit code while authorization is active.</p>
                <div className="solo-input"><Input value={operatorInput} onChange={(event) => updateOperatorInput(event.target.value, 6)} placeholder="6 digits" inputMode="numeric" maxLength={6} aria-label="Six-digit release code" /><Button disabled={operatorInput.length !== 6 || !isArmed} onClick={manualSubmit}>Send release</Button></div>
              </>
            )}
            {soloFeedback && <p className="solo-feedback" role="status">{soloFeedback}</p>}
          </div>
        </details>
      )}

      <footer className="story-footer"><span>Progress saved locally · Relay&apos;s voice is AI-generated.</span><em>Best {bestScore ? bestScore.toLocaleString("en-US") : "—"}</em></footer>
    </main>
  );
}
