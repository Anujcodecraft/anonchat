// public/utils.js
// Shared utilities for both chat and call

export function showToast(message, type="info") {
  Toastify({
    text: message,
    duration: 4000,
    gravity: "top",
    position: "right",
    style: {
      background:
        type === "success" ? "#10b981" :
        type === "error"   ? "#ef4444" :
        type === "warn"    ? "#f59e0b" : "#111"
    }
  }).showToast();
}

export const user_state = {
  IDLE:"IDLE",
  WAITING:"WAITING",
  IN_ROOM:"IN_ROOM"
}

export function navigateToPage(pageNumber) {
  const pages = document.querySelectorAll('.page');
  pages.forEach((p, idx) => {
    if (idx === pageNumber - 1) p.classList.add('active');
    else p.classList.remove('active');
  });

  const dotGroups = document.querySelectorAll('.progress-dots');
  dotGroups.forEach(group => {
    const dots = group.querySelectorAll('.dot');
    dots.forEach(d => d.classList.remove('active'));
    const activeIndex = Math.min(pageNumber - 1, dots.length - 1);
    if (dots[activeIndex]) dots[activeIndex].classList.add('active');
  });
}

export function createParticles() {
  const particlesContainer = document.getElementById('particles');
  if (!particlesContainer) return;
  const particleCount = 30;

  for (let i = 0; i < particleCount; i++) {
    const particle = document.createElement('div');
    particle.className = 'particle';

    const size = Math.random() * 4 + 2;
    const left = Math.random() * 100;
    const delay = Math.random() * 20;
    const duration = Math.random() * 10 + 15;

    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;
    particle.style.left = `${left}%`;
    particle.style.animationDelay = `${delay}s`;
    particle.style.animationDuration = `${duration}s`;

    const colors = [
      'rgba(139, 92, 246, 0.6)',
      'rgba(236, 72, 153, 0.6)',
      'rgba(255, 255, 255, 0.6)'
    ];
    particle.style.background = colors[Math.floor(Math.random() * colors.length)];

    particlesContainer.appendChild(particle);
  }
}

