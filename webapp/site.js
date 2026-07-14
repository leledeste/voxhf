'use strict';

// Public documentation pages stay dependency-free. This tiny helper adds a
// copy button to command blocks without analytics or persistent browser data.
document.querySelectorAll('pre').forEach(block => {
  const code = block.querySelector('code');
  if (!code) return;
  const button = document.createElement('button');
  button.className = 'copy-command';
  button.type = 'button';
  button.textContent = 'Copy';
  button.title = 'Copy command';
  button.setAttribute('aria-label', 'Copy command');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'OK';
      setTimeout(() => { button.textContent = 'Copy'; }, 1400);
    } catch (_) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });
  block.appendChild(button);
});

// Native details elements expose the right keyboard and accessibility
// behavior, but their content normally appears in a single frame. Animate the
// answer wrapper so it progressively moves the content below the FAQ.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
document.querySelectorAll('.faq-list details').forEach(details => {
  const summary = details.querySelector('summary');
  const answer = details.querySelector('.faq-answer');
  let animation = null;
  if (!summary || !answer || typeof answer.animate !== 'function') return;

  summary.addEventListener('click', event => {
    if (reducedMotion.matches) return;
    event.preventDefault();
    if (animation) return;

    const opening = !details.open;
    let startHeight;
    let endHeight;

    if (opening) {
      answer.style.height = '0px';
      details.open = true;
      startHeight = 0;
      endHeight = answer.scrollHeight;
    } else {
      details.classList.add('is-closing');
      startHeight = answer.getBoundingClientRect().height;
      endHeight = 0;
      answer.style.height = `${startHeight}px`;
    }

    animation = answer.animate(
      { height: [`${startHeight}px`, `${endHeight}px`] },
      { duration: 260, easing: 'cubic-bezier(.2, .7, .2, 1)', fill: 'both' },
    );

    animation.addEventListener('finish', () => {
      details.open = opening;
      details.classList.remove('is-closing');
      answer.style.removeProperty('height');
      animation.cancel();
      animation = null;
    }, { once: true });
  });
});

// The landing gallery uses the browser's native horizontal scrolling so it
// remains touch-friendly. These controls only add buttons, keyboard support,
// and a visible position indicator on top of that native behavior.
const carousel = document.querySelector('[data-carousel]');
if (carousel) {
  const slides = [...carousel.querySelectorAll(':scope > .feature-slide')];
  const previous = document.querySelector('[data-carousel-prev]');
  const next = document.querySelector('[data-carousel-next]');
  const position = document.querySelector('#carousel-position');
  const dots = [...document.querySelectorAll('[data-carousel-dot]')];
  let currentIndex = 0;
  let updateQueued = false;

  const updateControls = index => {
    currentIndex = Math.max(0, Math.min(slides.length - 1, index));
    if (position) position.textContent = `${currentIndex + 1} / ${slides.length}`;
    if (previous) previous.disabled = currentIndex === 0;
    if (next) next.disabled = currentIndex === slides.length - 1;
    dots.forEach((dot, dotIndex) => dot.setAttribute('aria-current', String(dotIndex === currentIndex)));
  };

  const findNearestSlide = () => {
    const center = carousel.scrollLeft + carousel.clientWidth / 2;
    let nearest = 0;
    let distance = Infinity;
    slides.forEach((slide, index) => {
      const slideCenter = slide.offsetLeft + slide.offsetWidth / 2;
      const candidate = Math.abs(center - slideCenter);
      if (candidate < distance) {
        nearest = index;
        distance = candidate;
      }
    });
    updateControls(nearest);
  };

  const scrollToSlide = index => {
    const targetIndex = Math.max(0, Math.min(slides.length - 1, index));
    const padding = Number.parseFloat(getComputedStyle(carousel).paddingLeft) || 0;
    carousel.scrollTo({
      left: Math.max(0, slides[targetIndex].offsetLeft - padding),
      behavior: 'smooth',
    });
    updateControls(targetIndex);
  };

  previous?.addEventListener('click', () => scrollToSlide(currentIndex - 1));
  next?.addEventListener('click', () => scrollToSlide(currentIndex + 1));
  dots.forEach((dot, index) => dot.addEventListener('click', () => scrollToSlide(index)));
  carousel.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    scrollToSlide(currentIndex + (event.key === 'ArrowRight' ? 1 : -1));
  });
  carousel.addEventListener('scroll', () => {
    if (updateQueued) return;
    updateQueued = true;
    requestAnimationFrame(() => {
      findNearestSlide();
      updateQueued = false;
    });
  }, { passive: true });
  window.addEventListener('resize', findNearestSlide);

  updateControls(0);
}
