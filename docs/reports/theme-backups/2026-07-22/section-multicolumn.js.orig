class MulticolumnVideoItem extends HTMLElement {
  constructor() {
    super();
    this.video = null;
    this.playButton = null;
    this.isPreviewPlaying = false;
    this.previewTimeout = null;
    this.previewDuration = parseInt(this.dataset.previewDuration) || 1500;
  }

  connectedCallback() {
    this.init();
  }

  disconnectedCallback() {
    this.cleanup();
  }

  init() {
    this.video = this.querySelector('video');
    this.playButton = this.querySelector('.video-play-button');

    if (!this.video || !this.playButton) return;

    // Preview functionality
    this.addEventListener('mouseenter', this.handleMouseEnter.bind(this));
    this.addEventListener('mouseleave', this.handleMouseLeave.bind(this));

    // Play button click handler
    this.playButton.addEventListener('click', this.handlePlayButtonClick.bind(this));

    // Video event handlers
    this.video.addEventListener('pause', this.handleVideoPause.bind(this));
    this.video.addEventListener('play', this.handleVideoPlay.bind(this));
    this.video.addEventListener('ended', this.handleVideoEnded.bind(this));
  }

  handleMouseEnter() {
    if (!this.classList.contains('playing')) {
      this.isPreviewPlaying = true;
      this.video.currentTime = 0;
      this.video.play();
      this.classList.add('previewing');

      // Set timeout to pause video after preview duration
      this.previewTimeout = setTimeout(() => {
        if (this.isPreviewPlaying && !this.classList.contains('playing')) {
          this.video.pause();
          this.video.currentTime = 0;
          this.classList.remove('previewing');
          this.isPreviewPlaying = false;
        }
      }, this.previewDuration);
    }
  }

  handleMouseLeave() {
    if (this.isPreviewPlaying && !this.classList.contains('playing')) {
      clearTimeout(this.previewTimeout);
      this.video.pause();
      this.video.currentTime = 0;
      this.classList.remove('previewing');
      this.isPreviewPlaying = false;
    }
  }

  handlePlayButtonClick(e) {
    e.stopPropagation();
    this.clearPreviewState();
    
    if (this.video.paused) {
      this.video.play();
      this.classList.add('playing');
    } else {
      this.video.pause();
      this.classList.remove('playing');
    }
  }

  handleVideoPause() {
    if (!this.isPreviewPlaying) {
      this.classList.remove('playing');
    }
  }

  handleVideoPlay() {
    if (!this.isPreviewPlaying) {
      this.classList.add('playing');
    }
  }

  handleVideoEnded() {
    if (this.isPreviewPlaying) {
      this.clearPreviewState();
    }
  }

  clearPreviewState() {
    clearTimeout(this.previewTimeout);
    this.isPreviewPlaying = false;
    this.classList.remove('previewing');
  }

  cleanup() {
    if (this.video && this.playButton) {
      this.removeEventListener('mouseenter', this.handleMouseEnter);
      this.removeEventListener('mouseleave', this.handleMouseLeave);
      this.playButton.removeEventListener('click', this.handlePlayButtonClick);
      this.video.removeEventListener('pause', this.handleVideoPause);
      this.video.removeEventListener('play', this.handleVideoPlay);
      this.video.removeEventListener('ended', this.handleVideoEnded);
      this.clearPreviewState();
    }
  }
}

// Register the custom element
if (!customElements.get('multicolumn-video-item')) {
  customElements.define('multicolumn-video-item', MulticolumnVideoItem);
}