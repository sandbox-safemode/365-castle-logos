// Vercel serverless function
// Generates an AI-edited castle image via Gemini, uploads to Supabase Storage,
// saves public URL in castle_edits table. No base64 blobs stored in the DB.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://mrnccntqmkxjazznejfc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ybmNjbnRxbWt4amF6em5lamZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMDA3NTksImV4cCI6MjA5MDc3Njc1OX0.T6oFTtYiFTsx6ojuogpZFXAS7tN5-dPzwvmY5V2xFGI';
const STORAGE_BUCKET = 'edit-images';

const GEMINI_MODEL = 'nano-banana-pro-preview';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { parentLogoId, sessionId, prompt, imageUrl } = req.body;
  if (!parentLogoId || !sessionId || !prompt || !imageUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Insert job row as 'processing'
  const { data: jobRow, error: insertErr } = await sb
    .from('castle_edits')
    .insert({
      parent_logo_id: parentLogoId,
      session_id: sessionId,
      prompt,
      source_image_url: imageUrl.startsWith('data:') ? '[data-url]' : imageUrl,
      status: 'processing',
      image_data_url: null,
      up_votes: 0,
      down_votes: 0,
    })
    .select('id')
    .single();

  if (insertErr) {
    console.error('Supabase insert error:', insertErr);
    return res.status(500).json({ error: insertErr.message });
  }

  const jobId = jobRow.id;

  // 2. Fetch the source image
  let imageB64;
  let imageMime = 'image/png';
  try {
    if (imageUrl.startsWith('data:')) {
      // Already a data URL (from "Edit again" on a previously edited image)
      const commaIdx = imageUrl.indexOf(',');
      const header = imageUrl.slice(0, commaIdx);
      imageB64 = imageUrl.slice(commaIdx + 1);
      const mimeMatch = header.match(/data:([^;]+)/);
      if (mimeMatch) imageMime = mimeMatch[1];
    } else {
      const imgRes = await fetch(imageUrl, { headers: { 'User-Agent': 'CastleVoteBot/1.0' } });
      if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
      const arrayBuf = await imgRes.arrayBuffer();
      imageB64 = Buffer.from(arrayBuf).toString('base64');
    }
  } catch (err) {
    await sb.from('castle_edits').update({ status: 'error', error_msg: `Image fetch: ${err.message}` }).eq('id', jobId);
    return res.status(200).json({ jobId, status: 'error', error: err.message });
  }

  // 3. Call Gemini for image editing
  let resultMime;
  let resultBuffer;
  try {
    const geminiPayload = {
      contents: [{
        parts: [
          { inline_data: { mime_type: imageMime, data: imageB64 } },
          { text: prompt }
        ]
      }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
    };

    const geminiRes = await fetch(
      `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error(`Gemini API error ${geminiRes.status}: ${errText.slice(0, 300)}`);
    }

    const geminiData = await geminiRes.json();
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData);

    if (!imagePart) {
      const textPart = parts.find(p => p.text);
      throw new Error(textPart?.text?.slice(0, 200) || 'No image returned by Gemini');
    }

    resultMime = imagePart.inlineData.mimeType;
    resultBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
  } catch (err) {
    console.error('Gemini error:', err.message);
    await sb.from('castle_edits').update({ status: 'error', error_msg: err.message.slice(0, 500) }).eq('id', jobId);
    return res.status(200).json({ jobId, status: 'error', error: err.message });
  }

  // 4. Upload image to Supabase Storage
  let publicUrl;
  try {
    const ext = resultMime === 'image/jpeg' ? 'jpg' : 'png';
    const filename = `${jobId}.${ext}`;

    const { error: uploadErr } = await sb.storage
      .from(STORAGE_BUCKET)
      .upload(filename, resultBuffer, {
        contentType: resultMime,
        upsert: true,
      });

    if (uploadErr) throw new Error(`Storage upload: ${uploadErr.message}`);

    const { data: urlData } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filename);
    publicUrl = urlData.publicUrl;
  } catch (err) {
    console.error('Storage error:', err.message);
    await sb.from('castle_edits').update({ status: 'error', error_msg: err.message.slice(0, 500) }).eq('id', jobId);
    return res.status(200).json({ jobId, status: 'error', error: err.message });
  }

  // 5. Save public URL to castle_edits
  const { error: updateErr } = await sb
    .from('castle_edits')
    .update({ status: 'done', image_data_url: publicUrl, error_msg: null })
    .eq('id', jobId);

  if (updateErr) {
    console.error('Supabase update error:', updateErr);
    return res.status(500).json({ error: updateErr.message });
  }

  return res.status(200).json({ jobId, status: 'done' });
}
