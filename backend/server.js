const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { v4: uuid } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const app  = express();
const PORT = process.env.PORT || 3000;

const R2 = new S3Client({
    region: 'auto',
    endpoint: 'https://0eaa31084e65b21c7dca412936394253.r2.cloudflarestorage.com',
    credentials: {
        accessKeyId:     'd63d1e1c7a232fc249c88cdc354545ee',
        secretAccessKey: '465d323dab40e2573cb6e49ced9f09fa31b43c8b7693824731bef79da0abf333'
    }
});

const BUCKET     = 'vindex-videos';
const PUBLIC_URL = 'https://pub-f35fcf9876b64020aaa1ff83e8bc43c6.r2.dev';
const DATA_FILE  = path.join(__dirname, 'data.json');

function readData() {
    if (!fs.existsSync(DATA_FILE)) return { videos: [], shorts: [] };
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { return { videos: [], shorts: [] }; }
}
function writeData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Salva su disco temporaneo invece che in RAM
const upload = multer({
    storage: multer.diskStorage({
        destination: os.tmpdir(),
        filename: (req, file, cb) => cb(null, uuid() + path.extname(file.originalname || '.mp4'))
    }),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/api/videos', (req, res) => {
    const data = readData();
    res.json({ videos: data.videos, shorts: data.shorts });
});

app.post('/api/upload', upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { title, description, type, tags, duration, channel, channelAvatar, thumbnail } = req.body;
    const tmpPath = req.file.path;

    try {
        // Upload a R2 in streaming dal file temporaneo su disco
        const videoKey = `videos/${uuid()}${path.extname(req.file.originalname || '.mp4')}`;
        const fileStream = fs.createReadStream(tmpPath);

        const uploader = new Upload({
            client: R2,
            params: {
                Bucket:      BUCKET,
                Key:         videoKey,
                Body:        fileStream,
                ContentType: req.file.mimetype || 'video/mp4'
            },
            queueSize: 1,       // upload sequenziale per usare meno RAM
            partSize:  10 * 1024 * 1024  // 10MB per chunk
        });
        await uploader.done();

        // Thumbnail
        let thumbUrl = '';
        if (thumbnail && thumbnail.startsWith('data:image')) {
            const thumbKey   = `thumbs/${uuid()}.jpg`;
            const base64Data = thumbnail.replace(/^data:image\/\w+;base64,/, '');
            await R2.send(new PutObjectCommand({
                Bucket:      BUCKET,
                Key:         thumbKey,
                Body:        Buffer.from(base64Data, 'base64'),
                ContentType: 'image/jpeg'
            }));
            thumbUrl = `${PUBLIC_URL}/${thumbKey}`;
        }

        const newVideo = {
            id:            uuid(),
            title:         title || 'Untitled',
            description:   description || '',
            channel:       channel || 'Anonymous',
            channelAvatar: channelAvatar || '👤',
            views:         '0',
            likes:         0,
            date:          new Date().toLocaleDateString('it-IT'),
            duration:      duration || '0:00',
            tags:          tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
            videoUrl:      `${PUBLIC_URL}/${videoKey}`,
            thumbnail:     thumbUrl,
            type:          type || 'video',
            r2Key:         videoKey,
            uploadedAt:    Date.now()
        };

        const data = readData();
        if (type === 'short') data.shorts.unshift(newVideo);
        else                  data.videos.unshift(newVideo);
        writeData(data);

        res.json({ success: true, video: newVideo });

    } catch(e) {
        console.error('Upload error:', e);
        res.status(500).json({ error: e.message });
    } finally {
        // Elimina file temporaneo
        fs.unlink(tmpPath, () => {});
    }
});

app.post('/api/videos/:id/like', (req, res) => {
    const data  = readData();
    const video = [...data.videos, ...data.shorts].find(v => v.id === req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    video.likes = (video.likes || 0) + 1;
    writeData(data); res.json({ likes: video.likes });
});

app.post('/api/videos/:id/view', (req, res) => {
    const data  = readData();
    const video = [...data.videos, ...data.shorts].find(v => v.id === req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    video.views = String((parseInt(video.views) || 0) + 1);
    writeData(data); res.json({ views: video.views });
});

app.delete('/api/videos/:id', async (req, res) => {
    const data = readData();
    const del  = async (arr) => {
        const i = arr.findIndex(v => v.id === req.params.id);
        if (i === -1) return false;
        if (arr[i].r2Key) await R2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: arr[i].r2Key })).catch(console.error);
        arr.splice(i, 1); return true;
    };
    const found = await del(data.videos) || await del(data.shorts);
    if (!found) return res.status(404).json({ error: 'Not found' });
    writeData(data); res.json({ success: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`Videx backend running on port ${PORT}`));
