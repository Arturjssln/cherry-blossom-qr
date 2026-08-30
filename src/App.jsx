import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_CONTENT } from './constants.js';
import { MAX_QR_BYTES, byteLength } from './qr.js';
import { styles } from './styles.js';
import { useWebGPUScene } from './useWebGPUScene.js';

const SEASON_LABELS = ['\u{1F338} Spring', '\u{1F33F} Summer', '\u{1F342} Autumn', '❄️ Winter'];

/**
 * Any string is encodable - the only hard limit is the QR byte budget.
 *
 * Note this counts UTF-8 *bytes*, not characters: an emoji is four bytes, so a
 * 600-emoji string is 2400 bytes and won't fit even though `.length` says 1200.
 */
function validateContent(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { valid: false, error: null };

  const bytes = byteLength(trimmed);
  if (bytes > MAX_QR_BYTES) {
    return {
      valid: false,
      error: `Too long for a QR code (${bytes} / ${MAX_QR_BYTES} bytes)`,
    };
  }
  return { valid: true, error: null };
}

export default function App() {
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  // `isFlat` lives in a ref so toggling the view doesn't re-init WebGPU; the
  // duplicate state exists only to re-render the helper label.
  const isFlatRef = useRef(false);
  const [isFlat, setIsFlat] = useState(false);

  const [inputValue, setInputValue] = useState(DEFAULT_CONTENT);
  const [qrContent, setQrContent] = useState(DEFAULT_CONTENT);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isValid, setIsValid] = useState(true);

  const seasonRef = useRef(0);
  const [season, setSeason] = useState(0);
  seasonRef.current = season;

  const measure = useCallback((node) => {
    if (!node) return;
    containerRef.current = node;
    const rect = node.getBoundingClientRect();
    setDimensions({ width: rect.width, height: rect.height * 0.75 });
  }, []);

  // 1-4 pick a season, space toggles the tree <-> QR view.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key >= '1' && e.key <= '4') {
        setSeason(parseInt(e.key, 10) - 1);
      } else if (e.key === ' ') {
        e.preventDefault();
        isFlatRef.current = !isFlatRef.current;
        setIsFlat(isFlatRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useWebGPUScene({
    canvasRef,
    canvasWidth: dimensions.width,
    canvasHeight: dimensions.height,
    qrContent,
    isFlat: isFlatRef,
    seasonRef,
  });

  const toggleView = useCallback(() => {
    isFlatRef.current = !isFlatRef.current;
    setIsFlat(isFlatRef.current);
  }, []);

  const handleInputChange = (e) => {
    const value = e.target.value;
    setInputValue(value);
    const { valid, error } = validateContent(value);
    setIsValid(valid);
    setHasError(Boolean(error));
    setErrorMessage(error ?? '');
  };

  const submit = () => {
    if (isValid) setQrContent(inputValue.trim());
  };

  if (!navigator.gpu) {
    return (
      <div style={styles.container}>
        <div style={styles.errorMessage}>
          <h2>WebGPU Not Supported</h2>
          <p>
            This demo requires WebGPU. Please use a browser that supports WebGPU
            (Chrome 113+, Edge 113+, or Firefox Nightly with flags enabled).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={measure} style={styles.container}>
      <div style={styles.canvasWrapper}>
        <canvas
          ref={canvasRef}
          onClick={toggleView}
          style={{
            ...styles.canvas,
            width: dimensions.width,
            height: dimensions.height,
            maxWidth: '100%',
            maxHeight: '100%',
            cursor: 'pointer',
          }}
        />
      </div>

      <div style={styles.helperText}>
        {isFlat ? 'Tap to see the tree' : 'Tap the tree to scan QR code'}
      </div>

      <div style={styles.inputContainer}>
        <div style={styles.inputRow}>
          <input
            type="text"
            aria-label="Text to encode"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="Enter a URL or any text"
            style={{ ...styles.input, ...(hasError ? styles.inputError : {}) }}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            onClick={submit}
            disabled={!isValid}
            aria-label="Generate QR code"
            style={{ ...styles.submitBtn, ...(isValid ? {} : styles.submitBtnDisabled) }}
          >
            {'→'}
          </button>
        </div>

        {hasError && errorMessage && <div style={styles.errorText}>{errorMessage}</div>}

        <div style={styles.seasonRow} role="radiogroup" aria-label="Season selector">
          {SEASON_LABELS.map((label, i) => (
            <button
              key={i}
              onClick={() => setSeason(i)}
              role="radio"
              aria-checked={season === i}
              aria-label={label}
              style={{ ...styles.seasonBtn, ...(season === i ? styles.seasonBtnActive : {}) }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
