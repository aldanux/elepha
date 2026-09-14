---
"elepha": minor
---

Add opt-in Memory Plus setup and manual vector generation with a local multilingual model or an explicitly configured OpenAI API key. Install the local Transformers runtime on demand into an isolated managed directory with extra ONNX binary downloads disabled, keeping it out of normal elepha installs. Refresh compatible runtime releases during self-update without failing the elepha update if the optional refresh fails. Store versioned vectors in the encrypted database, invalidate changed sources, and remove derived vectors when their source or consent is removed. Retrieval and hook behavior remain unchanged.
