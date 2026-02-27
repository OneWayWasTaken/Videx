const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { v4: uuid } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const THUMBS_DIR  = path.join(__dirname, 'thumbs');
const DATA_FILE   = path.join(__dirname, 'data.json');

[UPLOADS_DIR, THUMBS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

function readData() {
    if (!fs.existsSync(DATA_FILE)) return { videos: [], shorts: [] };
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { return { videos: [], shorts: [] }; }
}
function writeData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const storage = multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/thumbs',  express.static(THUMBS_DIR));

app.get('/api/videos', (req, res) => {
    const data = readData();
    res.json({ videos: data.videos, shorts: data.shorts });
});

app.post('/api/upload', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { title, description, type, tags, duration, channel, channelAvatar, thumbnail } = req.body;
    let thumbPath = '/placeholder.jpg';
    if (thumbnail && thumbnail.startsWith('data:image')) {
        const thumbName = uuid() + '.jpg';
        const base64Data = thumbnail.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(path.join(THUMBS_DIR, thumbName), Buffer.from(base64Data, 'base64'));
        thumbPath = `/thumbs/${thumbName}`;
    }
    const newVideo = {
        id: uuid(), title: title || 'Untitled', description: description || '',
        channel: channel || 'Anonymous', channelAvatar: channelAvatar || '👤',
        views: '0', likes: 0, date: new Date().toLocaleDateString('it-IT'),
        duration: duration || '0:00',
        tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        videoUrl: `/uploads/${req.file.filename}`,
        thumbnail: thumbPath, type: type || 'video', uploadedAt: Date.now()
    };
    const data = readData();
    if (type === 'short') data.shorts.unshift(newVideo);
    else data.videos.unshift(newVideo);
    writeData(data);
    res.json({ success: true, video: newVideo });
});

app.get('/api/stream/:filename', (req, res) => {
    const filePath = path.join(UPLOADS_DIR, path.basename(req.params.filename));
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': 'video/mp4',
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
        fs.createReadStream(filePath).pipe(res);
    }
});

app.post('/api/videos/:id/like', (req, res) => {
    const data = readData();
    const video = [...data.videos, ...data.shorts].find(v => v.id === req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    video.likes = (video.likes || 0) + 1;
    writeData(data); res.json({ likes: video.likes });
});

app.post('/api/videos/:id/view', (req, res) => {
    const data = readData();
    const video = [...data.videos, ...data.shorts].find(v => v.id === req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    video.views = String((parseInt(video.views) || 0) + 1);
    writeData(data); res.json({ views: video.views });
});

app.delete('/api/videos/:id', (req, res) => {
    const data = readData();
    const del = (arr) => {
        const i = arr.findIndex(v => v.id === req.params.id);
        if (i === -1) return false;
        const fname = path.basename(arr[i].videoUrl || '');
        const fp = path.join(UPLOADS_DIR, fname);
        if (fname && fs.existsSync(fp)) fs.unlinkSync(fp);
        arr.splice(i, 1); return true;
    };
    if (!del(data.videos) && !del(data.shorts)) return res.status(404).json({ error: 'Not found' });
    writeData(data); res.json({ success: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Videx backend running on port ${PORT}`));
