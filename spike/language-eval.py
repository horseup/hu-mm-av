"""Language eval for the transcription prompts (docs/SPIKE.md, follow-up section). Needs an AWS CLI session.

For each clip it names the language once (the plugin's detectPrompt), then transcribes with each prompt variant, and
prints how many answers kept the spoken language, how many came back empty, and the word error rate.

Input: a directory with <name>.wav files (16 kHz mono) and labels.tsv lines "<name>\t<en|de|none>\t<reference text>".
Clips in the spike were made with macOS `say` (Daniel, Samantha, Karen, Moira, Tessa, Rishi for English; Anna for
German and for German-accented English) and `ffmpeg -ar 16000 -ac 1`. Use fictional text only.

Usage: MODEL=mistral.voxtral-small-24b-2507 python3 -I spike/language-eval.py <dir> rules[,t1,t2,t3]
Keep the thread count low: eight parallel requests got errors that the harness treats as an unknown language.
"""

import base64, json, subprocess, sys, tempfile, os

RULES = (" Keep the speaker's exact words, grammar and form of address. Never translate, correct, summarize"
         " or add anything, and do not add quotation marks. If there is no clearly spoken human speech (silence, noise,"
         " music, tones, breathing), output exactly [no speech] and nothing else. Output only the transcript.")

VARIANTS = {
    # single-call prompts compared in the spike (use with transcribe(); "current" is what v0.1.3 sent)
    "current": lambda: "Transcribe this voice message verbatim, in the language that is spoken. The speaker most likely speaks German." + RULES,
    "nohint": lambda: "Transcribe this voice message verbatim, in the language that is spoken." + RULES,
    "soft": lambda: ("Transcribe this voice message verbatim, in the language that is spoken." + RULES +
                     " Most messages are in German, but if the speaker speaks English or any other language, write it in that language."),
    "first": lambda: ("First identify the spoken language, then transcribe this voice message verbatim in that same language."
                      " The output language must always equal the spoken language: English speech gives English text, German speech gives German text."
                      + RULES),
    "minimal": lambda: "Transcribe this audio verbatim, in the language that is spoken. Never translate. Output only the transcript, without quotation marks.",
    "nohint_nospeech": lambda: ("Transcribe this voice message verbatim, in the language that is spoken."
        " Keep the speaker's exact words, grammar and form of address. Never translate, correct, summarize"
        " or add anything, and do not add quotation marks. Output only the transcript."),
}

def detect(path):
    return run("Which language is spoken in this audio? Answer with the English name of the language only, one word. If there is no clearly spoken human speech (silence, noise, music, tones, breathing), answer None.", path)

def run(prompt, path):
    with open(path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()
    msgs = [{"role": "user", "content": [{"audio": {"format": "wav", "source": {"bytes": b64}}}, {"text": prompt}]}]
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as t:
        json.dump(msgs, t)
    try:
        out = subprocess.run(["aws", "bedrock-runtime", "converse", "--region", "eu-west-1",
                              "--model-id", os.environ.get("MODEL", "mistral.voxtral-mini-3b-2507"), "--messages", "file://" + t.name,
                              "--inference-config", '{"temperature":0,"maxTokens":2048}', "--output", "json"],
                             capture_output=True, text=True, timeout=60)
    finally:
        os.unlink(t.name)
    if out.returncode != 0:
        return "ERROR " + out.stderr.strip()[:200]
    d = json.loads(out.stdout)
    return "".join(c.get("text", "") for c in d["output"]["message"]["content"]).strip()



LANGS = ["English","German","French","Spanish","Italian","Dutch","Portuguese","Polish","Russian","Turkish","Arabic","Hindi","Chinese","Japanese","Korean","Swedish","Danish","Norwegian","Finnish","Czech","Greek","Hungarian","Romanian","Ukrainian"]
NOSPEECH_RULE = (" If there is no clearly spoken human speech (silence, noise,"
         " music, tones, breathing), output exactly [no speech] and nothing else.")
BASE = (" Keep the speaker's exact words, grammar and form of address. Never translate, correct, summarize"
        " or add anything, and do not add quotation marks. Output only the transcript.")

def parse_lang(ans):
    words = __import__("re").findall(r"[A-Za-z]+", ans)
    if any(w.lower() == "none" for w in words):
        return None
    hits = [w.capitalize() for w in words if w.capitalize() in LANGS]
    return hits[-1] if hits else ""

def transcribe(v, p):
    if v in ("detect", "detect2"):
        ans = detect(p)
        lang = parse_lang(ans)
        if lang is None:
            return "(None) [no speech]"
        if lang == "":
            lang = "German"  # fallback: the configured hint
        prompt = "Transcribe this voice message verbatim. The speaker speaks " + lang + "; write the transcript in " + lang + "." + BASE
        if v == "detect":
            prompt += NOSPEECH_RULE
        return "(" + lang + ") " + run(prompt, p)
    if v == "single":
        prompt = ("First name the language that is spoken, then transcribe the speech verbatim in that same language."
                  " Answer in exactly this form: <language name in English>: <transcript>. English speech gives English text, German speech gives German text."
                  + BASE.replace(" Output only the transcript.", "") +
                  " If there is no clearly spoken human speech (silence, noise, music, tones, breathing), answer exactly None: [no speech]")
        return run(prompt, p)
    return run(VARIANTS[v](), p)

import re
from concurrent.futures import ThreadPoolExecutor
import types
lt = types.SimpleNamespace(RULES=RULES, run=run, detect=detect, parse_lang=parse_lang)

PROMPTS = {
    "rules": lambda L: "Transcribe this voice message verbatim. The speaker speaks " + L + "; write the transcript in " + L + "." + lt.RULES,
    "t1": lambda L: "Write down word for word what the speaker says, in " + L + ". Output only those words.",
    "t2": lambda L: "Transcribe this audio. The speaker speaks " + L + ".",
    "t3": lambda L: "Write down word for word what the speaker says, in " + L + ". Never translate. Output only those words, without quotation marks.",
}
NUM = {"ten": "10", "three": "3", "four": "4", "five": "5", "drei": "3", "vier": "4", "fünf": "5", "zehn": "10"}
DE = set("der die das und ich ist nicht mit auf für bitte danke kannst du mir vom hat jemand neuen sie kann nächsten passt oder soll es ja heute wir können habe gerade läuft rufe dich später war schon wieder kaputt bis morgen zusammen aus dem stall euch ein schönes".split())
EN = set("the and is i to it on for please thanks can you me did anyone new she next does that or should yes see tomorrow just checked was again will we works my sounds good a from have now but".split())

def words(s):
    return [NUM.get(w, w) for w in re.findall(r"[a-zäöüß0-9]+", s.lower())]

def wer(ref, hyp):
    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))

def lang_of(t):
    w = words(t)
    if not w or "no speech" in t.lower():
        return "empty"
    de, en = sum(x in DE for x in w), sum(x in EN for x in w)
    return "de" if de > en else "en" if en > de else "?"

d = sys.argv[1]
variants = sys.argv[2].split(",")
clips = [l.rstrip("\n").split("\t") for l in open(os.path.join(d, "labels.tsv"))]

def one(c):
    path = os.path.join(d, c[0] + ".wav")
    ans = lt.detect(path)
    if ans.startswith("ERROR"): print("DETECT ERROR", c[0], ans[:120], flush=True)
    L = lt.parse_lang(ans)
    res = {}
    for v in variants:
        if L is None:
            res[v] = "[no speech]"
        else:
            res[v] = lt.run(PROMPTS[v](L or "German"), path)
    return c, L, res

with ThreadPoolExecutor(2) as ex:
    rows = list(ex.map(one, clips))

for v in variants:
    ok = empty = 0
    wers = []
    bad = []
    for (name, want, ref), L, res in rows:
        out = res[v]
        got = lang_of(out)
        if want == "none":
            good = got == "empty"
        else:
            good = got == want or (got == "?" and wer(ref, out) <= 0.5)
            w = wer(ref, out)
            wers.append(w)
            if w > 0.3:
                bad.append(f"  wer {w:.2f} {name} ({L}): {out[:160]}")
        if want != "none" and got == "empty":
            empty += 1
        ok += good
        if not good:
            bad.append(f"  LANG {name} ({L}): {out[:160]}")
    print(f"[{v}] language ok {ok}/{len(rows)}, empty on speech {empty}, mean WER {sum(wers)/len(wers):.3f}, clips with WER>0.3: {sum(w > 0.3 for w in wers)}")
    for b in bad:
        print(b)
    sys.stdout.flush()
