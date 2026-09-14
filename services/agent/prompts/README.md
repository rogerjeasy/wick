# Prompts are code

Versioned files, not string literals. Each has a golden-output test
(`docs/WICK-TECHNICAL.md` §12.4): real, redacted inputs and an expected *shape*
— JSON schema plus assertions on the constraints (word count, tense, no names,
no inference verbs).

A prompt change that alters golden outputs fails CI until the goldens are
consciously updated. Models drift; goldens catch it.
