"use client";

import { useRef } from "react";
import * as THREE from "three";
import { VRM } from "@pixiv/three-vrm";
import { loadVRM } from "../lib/vrm/loadVRM";
import { loadMixamoAnimation } from "../lib/fbx/loadMixamoAnimation";

const companionId = "companion_bebf00bb-8a43-488d-9c23-93c40b84d30e";
const companionUrl = "http://localhost:4000";
const firehoseUrl = "ws://localhost:8080";

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);

  let vrm: VRM;
  let mixer: THREE.AnimationMixer;
  const clock = new THREE.Clock();

  let audio: HTMLAudioElement;
  let recognition: SpeechRecognition;
  let talking: boolean = false;

  let audioCtx: AudioContext;
  let analyser: AnalyserNode;
  const timeDomainData = new Float32Array(2048);

  const talk = () => {
    recognition.start();
  };

  const init = async () => {
    if (!canvasRef.current || !videoRef.current || !captureCanvasRef.current)
      return;

    // --- WebSocket ---
    const ws = new WebSocket(firehoseUrl);
    ws.onmessage = async (evt) => {
      const json = JSON.parse(evt.data);
      if ("name" in json && json.name === "gesture") {
        playMotion(json.params.url);
      }
      if ("message" in json) {
        ["happy", "sad", "angry", "neutral"].map((value) => {
          value === json.metadata.emotion
            ? vrm.expressionManager?.setValue(value, 1)
            : vrm.expressionManager?.setValue(value, 0);
        });

        const response = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: json.message }),
        });

        if (!audioCtx) audioCtx = new AudioContext();
        if (!analyser) analyser = audioCtx.createAnalyser();

        const mediaSource = new MediaSource();
        if (audio) {
          audio.pause();
        }
        audio = new Audio();
        audio.src = URL.createObjectURL(mediaSource);
        talking = true;
        audio.play();

        mediaSource.addEventListener("sourceopen", async () => {
          const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
          if (!response.body) return null;
          const reader = response.body.getReader();

          const pump = async () => {
            const { done, value } = await reader.read();
            if (done) {
              mediaSource.endOfStream();
              return;
            }
            sourceBuffer.appendBuffer(value);
            await new Promise((resolve) => {
              sourceBuffer.addEventListener("updateend", resolve, {
                once: true,
              });
            });
            pump();
          };
          pump();
        });

        const sourceNode = audioCtx.createMediaElementSource(audio);
        sourceNode.connect(audioCtx.destination);
        sourceNode.connect(analyser);

        audio.onended = () => {
          talking = false;
        };
      }
    };

    // --- Camera キャプチャ ---
    setInterval(async () => {
      if (talking) return;
      const canvas = captureCanvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL("image/png").split(",")[1];
      if (!base64) return;

      await fetch(companionUrl + "/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "image", context: base64 }),
      });
    }, 60000);

    // --- Three.js ---
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    const renderer = new THREE.WebGLRenderer({ canvas: canvasRef.current });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x212121);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 3);
    directionalLight.position.set(1, 1, 1).normalize();
    scene.add(directionalLight);

    const ambientLight = new THREE.AmbientLight(0x404040, 2);
    scene.add(ambientLight);

    camera.position.set(0, 1, 1);

    // --- モーション ---
    const playIdle = async () => {
      const idleAnim = await loadMixamoAnimation("/models/Idle.fbx", vrm);
      if (!idleAnim) return;
      const idle = mixer.clipAction(idleAnim);
      idle.setLoop(THREE.LoopRepeat, Infinity);
      idle.play();
    };

    const playMotion = async (path: string) => {
      const anim = await loadMixamoAnimation(path, vrm);
      if (!anim) return;
      mixer.stopAllAction();
      const action = mixer.clipAction(anim);
      action.play();
      action.setLoop(THREE.LoopRepeat, 1);
      mixer.addEventListener("finished", (e) => {
        if (e.action === action) playIdle();
      });
    };

    const loadModel = async () => {
      const { gltf } = await loadVRM("/models/AliciaSolid-1.0.vrm");
      vrm = gltf.userData.vrm;
      scene.add(gltf.scene);
      mixer = new THREE.AnimationMixer(gltf.scene);
      playIdle();
    };

    const animate = () => {
      requestAnimationFrame(animate);
      const deltaTime = clock.getDelta();
      if (mixer) mixer.update(deltaTime);
      if (vrm) vrm.update(deltaTime);
      if (analyser && vrm.expressionManager) {
        analyser.getFloatTimeDomainData(timeDomainData);
        let volume = 0;
        for (let i = 0; i < timeDomainData.length; i++) {
          volume = Math.max(volume, Math.abs(timeDomainData[i]));
        }
        volume = 1 / (1 + Math.exp(-45 * volume + 5));
        if (volume < 0.1) volume = 0;
        vrm.expressionManager.setValue("aa", volume);
      }
      renderer.render(scene, camera);
    };

    window.addEventListener("resize", () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // --- ユーザーカメラ ---
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    videoRef.current.srcObject = stream;
    await videoRef.current.play();

    // --- 発話認識 ---
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    recognition = new SpeechRecognition();
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[event.results.length - 1][0].transcript;
      if (transcript.length <= 5) return;
      console.log(transcript);
      recognition.stop();
      ws.send(
        JSON.stringify(
          { from: "user", message: transcript, target: companionId },
          null,
          2
        )
      );
    };

    await loadModel();
    animate();
  };

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
      <video ref={videoRef} style={{ display: "none" }} />
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
      <button
        onClick={init}
        style={{
          position: "absolute",
          top: "20px",
          left: "20px",
          zIndex: 10,
          padding: "10px 20px",
          fontSize: "16px",
          borderRadius: "8px",
          backgroundColor: "#ff69b4",
          color: "#fff",
          border: "none",
          cursor: "pointer",
        }}
      >
        Start
      </button>
      <button
        onClick={talk}
        style={{
          position: "absolute",
          top: "20px",
          left: "120px",
          zIndex: 10,
          padding: "10px 20px",
          fontSize: "16px",
          borderRadius: "8px",
          backgroundColor: "#ff69b4",
          color: "#fff",
          border: "none",
          cursor: "pointer",
        }}
      >
        Talk
      </button>
      <canvas ref={captureCanvasRef} style={{ display: "none" }} />
    </div>
  );
}
