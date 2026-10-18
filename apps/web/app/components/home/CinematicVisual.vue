<script setup lang="ts">
// The orbit uses the real, approved vector mark from the brand assets.
import brandMark from '#brand/lb-mark-dark.svg?url'

const { t } = useI18n()
</script>

<template>
  <div class="cinematic-visual" aria-hidden="true">
    <div class="planet-halo" />
    <div class="planet">
      <div class="planet-longitudes" />
      <div class="planet-latitudes" />
      <div class="planet-core">
        <img
          :src="brandMark"
          alt=""
          width="180"
          height="145"
          loading="eager"
          decoding="async"
        >
      </div>
    </div>
    <div class="orbit orbit-one" />
    <div class="orbit orbit-two" />
    <div class="orbit orbit-three" />
    <span class="orbit-node node-one" />
    <span class="orbit-node node-two" />
    <span class="orbit-node node-three" />

    <div class="floating-card card-top">
      <span class="card-icon">◈</span>
      <span>
        <strong>10</strong>
        <small>{{ t('home.proof.systems') }}</small>
      </span>
    </div>
    <div class="floating-card card-middle">
      <span class="card-icon">⌘</span>
      <span>
        <strong>EN / CZ</strong>
        <small>{{ t('home.proof.languages') }}</small>
      </span>
    </div>
    <div class="floating-card card-bottom">
      <span class="card-icon">↗</span>
      <span>
        <strong>01—10</strong>
        <small>{{ t('home.proof.traces') }}</small>
      </span>
    </div>
    <div class="visual-caption">
      BUILD <span>↗</span> EVALUATE <span>↗</span> DEPLOY
    </div>
  </div>
</template>

<style scoped>
.cinematic-visual {
  position: relative;
  width: 100%;
  min-height: clamp(360px, 37vw, 560px);
  isolation: isolate;
  overflow: hidden;
}
.cinematic-visual::before {
  content: '';
  position: absolute;
  inset: 8%;
  background: repeating-conic-gradient(from 0deg, rgb(70 169 255 / 9%) 0 1deg, transparent 1deg 17deg);
  border-radius: 50%;
  filter: blur(2px);
  animation: blueprint-turn 65s linear infinite;
}
.planet-halo {
  position: absolute;
  inset: 4%;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 50%, transparent 32%, rgb(0 122 255 / 10%) 48%, transparent 69%);
  filter: blur(11px);
  animation: halo-breathe 7s ease-in-out infinite alternate;
}
.planet {
  position: absolute;
  inset: 13%;
  border-radius: 50%;
  overflow: hidden;
  border: 1px solid rgb(135 220 255 / 75%);
  background:
    radial-gradient(ellipse at 31% 22%, rgb(101 217 255 / 30%), transparent 40%),
    radial-gradient(ellipse at 62% 74%, #051532 5%, #092c67 37%, #0052b566 58%, #030b1c 77%);
  box-shadow:
    inset -42px -32px 90px rgb(0 0 0 / 84%),
    inset 19px 11px 32px rgb(72 183 255 / 24%),
    0 0 1px 3px rgb(84 189 255 / 13%),
    0 0 45px rgb(18 123 253 / 64%),
    0 0 125px rgb(15 94 217 / 34%);
  animation: float-planet 8s ease-in-out infinite alternate;
}
.planet-longitudes,
.planet-latitudes {
  position: absolute;
  inset: 6%;
  border-radius: 50%;
  pointer-events: none;
}
.planet-longitudes {
  background: repeating-linear-gradient(90deg, transparent 0 14.8%, rgb(109 213 255 / 20%) 15% 15.3%, transparent 15.5% 30%);
  transform: perspective(270px) rotateY(57deg);
}
.planet-latitudes {
  background: repeating-linear-gradient(0deg, transparent 0 14.8%, rgb(125 211 255 / 26%) 15% 15.3%, transparent 15.5% 30%);
  transform: perspective(270px) rotateX(54deg);
}
.planet-core {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: clamp(5rem, 15vw, 12rem);
  font-weight: 900;
  font-stretch: 125%;
  line-height: 1;
  letter-spacing: -.13em;
  padding-right: .12em;
  color: rgb(227 247 255 / 85%);
  text-shadow: 0 0 30px rgb(42 177 255 / 80%), 0 0 100px rgb(21 101 255 / 95%);
  mix-blend-mode: screen;
}
.planet-core img {
  display: block;
  width: clamp(130px, 17vw, 210px);
  height: auto;
  filter: drop-shadow(0 0 17px rgb(51 173 255 / 48%));
}
.orbit {
  position: absolute;
  border: 1px solid rgb(105 195 255 / 55%);
  border-radius: 50%;
  box-shadow: 0 0 26px rgb(16 136 255 / 14%);
}
.orbit-one { inset: 17% 1%; transform: rotate(-29deg); animation: tilt-one 16s ease-in-out infinite alternate; }
.orbit-two { inset: 8% 29%; transform: rotate(22deg); animation: tilt-two 22s ease-in-out infinite alternate; }
.orbit-three { inset: 31% -5%; transform: rotate(23deg); opacity: .35; }
.orbit-node {
  position: absolute;
  z-index: 3;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #b9f4ff;
  box-shadow: 0 0 0 4px rgb(68 158 255 / 21%), 0 0 22px 6px #229dff;
}
.node-one { top: 18%; right: 24%; }
.node-two { bottom: 24%; left: 10%; }
.node-three { top: 46%; right: 8%; }
.floating-card {
  position: absolute;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: 160px;
  padding: 12px;
  border: 1px solid rgb(123 194 251 / 46%);
  border-radius: 9px;
  background: rgb(8 23 45 / 83%);
  box-shadow: 0 10px 29px rgb(0 0 0 / 39%), inset 0 1px rgb(126 192 255 / 17%);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  animation: card-hover 7s ease-in-out infinite alternate;
}
.card-top { top: 10%; right: 0; }
.card-middle { top: 46%; left: 1%; animation-delay: -2s; }
.card-bottom { right: 2%; bottom: 13%; animation-delay: -4s; }
.card-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  color: #b6eeff;
  border: 1px solid rgb(113 186 255 / 44%);
  border-radius: 6px;
  background: rgb(43 124 228 / 16%);
}
.floating-card strong {
  display: block;
  font: 700 13px/1.2 var(--lb-font-mono);
  color: #f6fbff;
}
.floating-card small {
  display: block;
  max-width: 105px;
  margin-top: 4px;
  font: 500 9px/1.4 var(--lb-font-sans);
  color: #a9c7e6;
}
.visual-caption {
  position: absolute;
  right: 50%;
  bottom: 2%;
  transform: translateX(50%);
  white-space: nowrap;
  font: 600 10px/1.4 var(--lb-font-mono);
  letter-spacing: .09em;
  color: #95b9de;
}
.visual-caption span { color: #4abaff; margin-inline: 12px; }
@keyframes float-planet { to { transform: translateY(-12px) scale(1.025); } }
@keyframes blueprint-turn { to { transform: rotate(360deg); } }
@keyframes halo-breathe { to { opacity: .55; transform: scale(1.04); } }
@keyframes tilt-one { to { transform: rotate(-41deg); } }
@keyframes tilt-two { to { transform: rotate(33deg); } }
@keyframes card-hover { to { transform: translateY(-9px); } }
@media (max-width: 780px) {
  .cinematic-visual { min-height: 370px; max-width: 500px; margin: 0 auto; }
  .planet-core { font-size: clamp(5rem, 24vw, 9rem); }
}
@media (max-width: 450px) {
  .cinematic-visual { min-height: 315px; }
  .floating-card { padding: 8px; }
  .card-icon { width: 24px; height: 24px; }
  .floating-card strong { font-size: 10px; }
  .floating-card small { font-size: 8px; }
  .visual-caption { font-size: 8px; }
}
@media (prefers-reduced-motion: reduce) {
  .cinematic-visual::before,
  .planet-halo,
  .planet,
  .orbit,
  .floating-card { animation: none; }
}
</style>
