require('dotenv').config();
const express = require('express');
const path = require('path');
const Parser = require('rss-parser');

const app = express();
const PORT = 3000;
const parser = new Parser({ timeout: 10000 });

app.use(express.json());

const FEEDS = [
    { name: 'NDTV',           url: 'https://feeds.feedburner.com/ndtvnews-top-stories' },
    { name: 'Times of India', url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms' },
    { name: 'Indian Express', url: 'https://indianexpress.com/feed/' },
];

app.get('/api/news', async (req, res) => {
    try {
        const results = await Promise.allSettled(FEEDS.map(f => parser.parseURL(f.url)));

        const articles = [];
        results.forEach((result, i) => {
            if (result.status !== 'fulfilled') {
                console.error(`[${FEEDS[i].name}] feed failed:`, result.reason?.message);
                return;
            }
            (result.value.items || []).slice(0, 4).forEach(item => {
                const title = item.title?.trim();
                if (!title) return;
                const description = (item.contentSnippet || item.summary || '')
                    .replace(/<[^>]*>/g, '')
                    .trim()
                    .slice(0, 250);
                articles.push({ title, description });
            });
        });

        if (articles.length === 0) {
            return res.status(502).json({ error: 'All RSS feeds failed to load.' });
        }

        res.json({ articles });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch news' });
    }
});

app.post('/api/summary', async (req, res) => {
    const { articles } = req.body || {};
    if (!Array.isArray(articles) || articles.length === 0) {
        return res.status(400).json({ error: 'articles array is required' });
    }

    const headlineBlock = articles
        .map((a, i) => {
            let line = `${i + 1}. ${a.title}`;
            if (a.description) line += `\n   ${a.description}`;
            return line;
        })
        .join('\n\n');

    const prompt =
`Here are today's top ${articles.length} news headlines from India:

${headlineBlock}

Please write two warm, plain-language summaries of these stories — one in English, one in Hindi.

Imagine you are a loving family member sitting with your elderly parent or grandparent (age 65+) over morning chai, telling them what happened in the country today. Tone: warm, calm, conversational. Language: very simple words, short sentences.

IMPORTANT — be specific, not vague:
- Always use the real names of people, places, organisations, and cities mentioned in the headlines. Never replace them with vague words like "a leader", "a city", or "some people".
- Include actual numbers and figures where they matter (prices, vote counts, distances, years, amounts).
- If a headline mentions an event in Mumbai, say Mumbai. If it names the Prime Minister, say the Prime Minister's name. If a missile test happened, name the missile.
- Cover the 4–5 most important stories across the headlines in 3–4 paragraphs.
- Avoid jargon, acronyms, and technical terms — but do keep the real nouns.

Return ONLY a valid JSON object — no extra text, no markdown — in exactly this format:
{
  "english": "Paragraph one.\\n\\nParagraph two.\\n\\nParagraph three.",
  "hindi": "पहला पैराग्राफ।\\n\\nदूसरा पैराग्राफ।\\n\\nतीसरा पैराग्राफ।"
}`;

    let anthropicRes;
    try {
        anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'claude-opus-4-5',
                max_tokens: 1200,
                messages: [{ role: 'user', content: prompt }]
            })
        });
    } catch (e) {
        return res.status(502).json({ error: 'Could not reach the Claude API.' });
    }

    if (!anthropicRes.ok) {
        let detail = '';
        try { detail = (await anthropicRes.json()).error?.message || ''; } catch (_) {}
        return res.status(502).json({ error: `Claude API error ${anthropicRes.status}: ${detail || anthropicRes.statusText}` });
    }

    const data = await anthropicRes.json();
    const raw  = data.content?.[0]?.text || '';

    const parsed = parseJSONSafely(raw);
    if (!parsed) {
        return res.status(502).json({ error: 'Could not parse the summary returned by Claude.' });
    }

    res.json(parsed);
});

function parseJSONSafely(text) {
    try { return JSON.parse(text); } catch (_) {}
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) { try { return JSON.parse(fenced[1]); } catch (_) {} }
    const block = text.match(/\{[\s\S]*?"english"[\s\S]*?"hindi"[\s\S]*?\}/);
    if (block) { try { return JSON.parse(block[0]); } catch (_) {} }
    return null;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'aaj-ka-samachar.html'));
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
