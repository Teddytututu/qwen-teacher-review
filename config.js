// Preserve the verified target-commit repository; explicit local configuration may override it. No token belongs here.
window.QWEN_REVIEW_CONFIG = {...(window.QWEN_REVIEW_CONFIG || {}), apiBase: window.QWEN_REVIEW_CONFIG?.apiBase || 'https://api.github.com/repos/Teddytututu/qwen-teacher-review'};
