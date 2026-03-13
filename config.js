// API key resolution: config.local.js (gitignored) > localStorage > prompt via modal.
// To set keys permanently, create config.local.js with:
//   var LOCAL_KEYS = { OPENAI_API_KEY: 'sk-...', ANTHROPIC_API_KEY: 'sk-...' };

const CONFIG = {
    get OPENAI_API_KEY() {
        return (typeof LOCAL_KEYS !== 'undefined' && LOCAL_KEYS.OPENAI_API_KEY)
            || localStorage.getItem('teleprompter_openai_key') || '';
    },
    get ANTHROPIC_API_KEY() {
        return (typeof LOCAL_KEYS !== 'undefined' && LOCAL_KEYS.ANTHROPIC_API_KEY)
            || localStorage.getItem('teleprompter_anthropic_key') || '';
    },
    setOpenAIKey(key) {
        localStorage.setItem('teleprompter_openai_key', key);
    },
    setAnthropicKey(key) {
        localStorage.setItem('teleprompter_anthropic_key', key);
    },
    clearKeys() {
        localStorage.removeItem('teleprompter_openai_key');
        localStorage.removeItem('teleprompter_anthropic_key');
    },
    hasKeys() {
        return !!(this.OPENAI_API_KEY || this.ANTHROPIC_API_KEY);
    },
};
