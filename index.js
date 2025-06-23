const ariClient = require('ari-client');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const { exec, spawn, execSync } = require('child_process');
const dgram = require('dgram');
const WebSocket = require('ws');

// -------- TIMESTAMP LOGS --------
['log', 'warn', 'error'].forEach(method => {
  const original = console[method];
  console[method] = (...args) => {
    const timestamp = new Date().toISOString();
    original(`[${timestamp}]`, ...args);
  };
});
// ------------------------------

// -------- TƏNZİMLƏMƏLƏR (DİQQƏT!) --------
const ASTERISK_URL = 'http://localhost:8088';
const ASTERISK_USERNAME = 'voicebot_user';         // Addım 1.2-də yaratdığınız istifadəçi adı
const ASTERISK_PASSWORD = 'SuperGucluParol123';    // Addım 1.2-də təyin etdiyiniz parol
const ARI_APP_NAME = 'voicebot_app';               // Addım 1.3-də istifadə etdiyiniz ad
const WEBSOCKET_URL = 'ws://localhost:3001';   // Qoşulacağımız WebSocket serveri
const BASE_UDP_PORT = 10000;                       // Səs axını üçün istifadə ediləcək başlanğıc UDP portu

// Asterisk-in standart səs qovluğunu istifadə edirik
const SOUNDS_DIR = '/var/lib/asterisk/sounds/';
const RECORDINGS_DIR = path.join(__dirname, 'recordings');

// Səsləri hazırlayan funksiya
function setupSounds() {
    // Asterisk-in səs qovluğu artıq mövcud olmalıdır, yoxlayaq
    if (!fs.existsSync(SOUNDS_DIR)) {
        console.error(`❌ XƏTA: Asterisk səs qovluğu tapılmadı: ${SOUNDS_DIR}`);
        console.error(`Bu qovluq Asterisk tərəfindən yaradılmalıdır. Asterisk düzgün qurulub?`);
        process.exit(1);
    }
    
    // Yazma icazəsini yoxlayaq
    try {
        fs.accessSync(SOUNDS_DIR, fs.constants.W_OK);
        console.log(`✅ Asterisk səs qovluğuna (${SOUNDS_DIR}) yazma icazəsi var.`);
    } catch (err) {
        console.error(`❌ XƏTA: Asterisk səs qovluğuna yazma icazəsi yoxdur: ${SOUNDS_DIR}`);
        console.error(`İcazələri düzəltmək üçün: sudo chmod 775 ${SOUNDS_DIR} && sudo usermod -a -G asterisk $(whoami)`);
        process.exit(1);
    }
}

// Səs yazılarını saxlamaq üçün qovluq yaradan funksiya
function setupRecordings() {
    if (!fs.existsSync(RECORDINGS_DIR)) {
        fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
        console.log(`Səs yazıları üçün qovluq yaradıldı: ${RECORDINGS_DIR}`);
    }
}

// Toplanmış səs parçalarını .wav faylı kimi saxlayan funksiya
async function saveIncomingRecording(channelId, audioChunks) {
    if (!audioChunks || audioChunks.length === 0) {
        console.log(`[${channelId}] [INCOMING] Yazmaq üçün səs datası tapılmadı.`);
        return;
    }

    console.log(`[${channelId}] [INCOMING] Gələn səs yazısı yaddaşa verilir... Toplam ${audioChunks.length} parça.`);
    
    try {
        const fullAudio = Buffer.concat(audioChunks);
        console.log(`[${channelId}] [INCOMING] Toplam səs ölçüsü: ${fullAudio.length} bayt`);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const wavFileName = `${channelId}_INCOMING_${timestamp}.wav`;
        const rawFilePath = path.join(RECORDINGS_DIR, `${wavFileName}.raw`);
        const wavFilePath = path.join(RECORDINGS_DIR, wavFileName);

        // 1. Xam ulaw faylını yazırıq
        await fsPromises.writeFile(rawFilePath, fullAudio);
        console.log(`[${channelId}] [INCOMING] Müvəqqəti xam fayl yazıldı: ${rawFilePath} (${fullAudio.length} bayt)`);

        // 2. sox ilə WAV formatına çeviririk (ulaw 8kHz -> WAV)
        const soxCommand = `sox -t ul -r 8000 -c 1 "${rawFilePath}" "${wavFilePath}"`;
        console.log(`[${channelId}] [INCOMING] Sox əmri icra edilir: ${soxCommand}`);
        
        await new Promise((resolve, reject) => {
            exec(soxCommand, (error, stdout, stderr) => {
                if (error) {
                    console.error(`[${channelId}] [INCOMING] sox konvertasiya xətası: ${stderr}`);
                    fsPromises.unlink(rawFilePath).catch(e => console.error(`[${channelId}] [INCOMING] Müvəqqəti faylı silərkən xəta: ${e.message}`));
                    return reject(error);
                }
                console.log(`[${channelId}] [INCOMING] ✅ Gələn səs yazısı uğurla WAV formatına çevrildi: ${wavFilePath}`);
                if (stdout) console.log(`[${channelId}] [INCOMING] Sox stdout: ${stdout}`);
                resolve(stdout);
            });
        });

        // 3. Müvəqqəti xam faylı silirik
        await fsPromises.unlink(rawFilePath);
        console.log(`[${channelId}] [INCOMING] Müvəqqəti xam fayl silindi.`);

    } catch (err) {
        console.error(`[${channelId}] [INCOMING] Gələn səs yazısını yaddaşa verərkən xəta:`, err);
    }
}

// WebSocket-ə göndərilən səs parçalarını .wav faylı kimi saxlayan funksiya
async function saveOutgoingRecording(channelId, audioChunks) {
    if (!audioChunks || audioChunks.length === 0) {
        console.log(`[${channelId}] [OUTGOING] Yazmaq üçün səs datası tapılmadı.`);
        return;
    }

    console.log(`[${channelId}] [OUTGOING] Göndərilən səs yazısı yaddaşa verilir... Toplam ${audioChunks.length} parça.`);
    
    try {
        const fullAudio = Buffer.concat(audioChunks);
        console.log(`[${channelId}] [OUTGOING] Toplam səs ölçüsü: ${fullAudio.length} bayt`);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const wavFileName = `${channelId}_OUTGOING_${timestamp}.wav`;
        const rawFilePath = path.join(RECORDINGS_DIR, `${wavFileName}.raw`);
        const wavFilePath = path.join(RECORDINGS_DIR, wavFileName);

        // 1. Xam slin16 faylını yazırıq
        await fsPromises.writeFile(rawFilePath, fullAudio);
        console.log(`[${channelId}] [OUTGOING] Müvəqqəti xam fayl yazıldı: ${rawFilePath} (${fullAudio.length} bayt)`);

        // 2. sox ilə WAV formatına çeviririk (slin16 16kHz -> WAV)
        const soxCommand = `sox -t raw -r 16000 -e signed-integer -b 16 -L -c 1 "${rawFilePath}" "${wavFilePath}"`;
        console.log(`[${channelId}] [OUTGOING] Sox əmri icra edilir: ${soxCommand}`);
        
        await new Promise((resolve, reject) => {
            exec(soxCommand, (error, stdout, stderr) => {
                if (error) {
                    console.error(`[${channelId}] [OUTGOING] sox konvertasiya xətası: ${stderr}`);
                    fsPromises.unlink(rawFilePath).catch(e => console.error(`[${channelId}] [OUTGOING] Müvəqqəti faylı silərkən xəta: ${e.message}`));
                    return reject(error);
                }
                console.log(`[${channelId}] [OUTGOING] ✅ Göndərilən səs yazısı uğurla WAV formatına çevrildi: ${wavFilePath}`);
                if (stdout) console.log(`[${channelId}] [OUTGOING] Sox stdout: ${stdout}`);
                resolve(stdout);
            });
        });

        // 3. Müvəqqəti xam faylı silirik
        await fsPromises.unlink(rawFilePath);
        console.log(`[${channelId}] [OUTGOING] Müvəqqəti xam fayl silindi.`);

    } catch (err) {
        console.error(`[${channelId}] [OUTGOING] Göndərilən səs yazısını yaddaşa verərkən xəta:`, err);
    }
}

// Playback üçün nəzərdə tutulmuş səsi yoxlamaq üçün saxlayan funksiya
async function savePlaybackDebugRecording(channelId, audioChunks) {
    if (!audioChunks || audioChunks.length === 0) {
        console.log(`[${channelId}] [PLAYBACK_DEBUG] Yazmaq üçün səs datası tapılmadı.`);
        return;
    }

    console.log(`[${channelId}] [PLAYBACK_DEBUG] Səsləndiriləcək səs yaddaşa verilir... Toplam ${audioChunks.length} parça.`);
    
    try {
        const fullAudio = Buffer.concat(audioChunks);
        console.log(`[${channelId}] [PLAYBACK_DEBUG] Toplam səs ölçüsü: ${fullAudio.length} bayt`);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const wavFileName = `${channelId}_PLAYBACK_DEBUG_${timestamp}.wav`;
        const rawFilePath = path.join(RECORDINGS_DIR, `${wavFileName}.raw`);
        const wavFilePath = path.join(RECORDINGS_DIR, wavFileName);

        // 1. Xam slin16 faylını yazırıq
        await fsPromises.writeFile(rawFilePath, fullAudio);
        console.log(`[${channelId}] [PLAYBACK_DEBUG] Müvəqqəti xam fayl yazıldı: ${rawFilePath} (${fullAudio.length} bayt)`);

        // 2. sox ilə WAV formatına çeviririk (slin16 16kHz -> WAV)
        const soxCommand = `sox -t raw -r 16000 -e signed-integer -b 16 -L -c 1 "${rawFilePath}" "${wavFilePath}"`;
        console.log(`[${channelId}] [PLAYBACK_DEBUG] Sox əmri icra edilir: ${soxCommand}`);
        
        await new Promise((resolve, reject) => {
            exec(soxCommand, (error, stdout, stderr) => {
                if (error) {
                    console.error(`[${channelId}] [PLAYBACK_DEBUG] sox konvertasiya xətası: ${stderr}`);
                    fsPromises.unlink(rawFilePath).catch(e => console.error(`[${channelId}] [PLAYBACK_DEBUG] Müvəqqəti faylı silərkən xəta: ${e.message}`));
                    return reject(error);
                }
                console.log(`[${channelId}] [PLAYBACK_DEBUG] ✅ Səsləndiriləcək səs uğurla WAV formatına çevrildi: ${wavFilePath}`);
                if (stdout) console.log(`[${channelId}] [PLAYBACK_DEBUG] Sox stdout: ${stdout}`);
                resolve(stdout);
            });
        });

        // 3. Müvəqqəti xam faylı silirik
        await fsPromises.unlink(rawFilePath);
        console.log(`[${channelId}] [PLAYBACK_DEBUG] Müvəqqəti xam fayl silindi.`);

    } catch (err) {
        console.error(`[${channelId}] [PLAYBACK_DEBUG] Səsləndiriləcək səsi yaddaşa verərkən xəta:`, err);
    }
}

// Hər bir aktiv zəng üçün bütün resursları saxlayan obyekt
const callStates = new Map();
let nextUdpPort = BASE_UDP_PORT;

// Zəngə aid bütün resursları (sox, pipe, ws, kanallar) təmizləyən funksiya
async function cleanupCallResources(channelId) {
    if (callStates.has(channelId)) {
        const state = callStates.get(channelId);
        
        console.log(`[${channelId}] [CLEANUP] Təmizləmə başlayır...`);
        
        // Təmizləmədən əvvəl səs yazılarını yaddaşa veririk
        console.log(`[${channelId}] [CLEANUP] Səs yazıları saxlanılır...`);
        await saveIncomingRecording(channelId, state.audioChunks);
        await saveOutgoingRecording(channelId, state.outgoingAudioChunks);
        await savePlaybackDebugRecording(channelId, state.playbackAudioChunks); // Debug faylını saxlayırıq
        
        console.log(`[${channelId}] Bütün resurslar təmizlənir...`);

        // Davam edən səsləndirməni dayandırırıq
        if (state.continuousPlayback && !state.continuousPlayback.destroyed) {
            console.log(`[${channelId}] Təmizləmə: Continuous playback obyektini dayandırıram...`);
            try { await state.continuousPlayback.stop(); } catch (e) { console.log(`[${channelId}] Təmizləmə: Playback dayandırarkən xəta (normaldır): ${e.message}`); }
        }
        
        // Continuous sox prosesini dayandırırıq
        if (state.continuousSoxProcess) {
            console.log(`[${channelId}] Təmizləmə: Continuous sox prosesini dayandırıram...`);
            state.continuousSoxProcess.kill('SIGTERM');
        }
        
        // Continuous pipe faylını silirik
        if (state.continuousPipePath && fs.existsSync(state.continuousPipePath)) {
            console.log(`[${channelId}] Təmizləmə: Continuous pipe faylını (${state.continuousPipePath}) silirəm...`);
            fs.unlinkSync(state.continuousPipePath);
        }
        
        // sox prosesini dayandırırıq
        if (state.soxProcess) {
            console.log(`[${channelId}] Təmizləmə: sox prosesini dayandırıram...`);
            state.soxProcess.kill('SIGTERM');
        }
        // ulaw->slin16 konversiya prosesini dayandırırıq
        if (state.ulawToSlinProcess) {
            console.log(`[${channelId}] Təmizləmə: ulaw->slin16 sox prosesini dayandırıram...`);
            state.ulawToSlinProcess.kill('SIGTERM');
        }
        // Yaradılmış named pipe faylını silirik
        if (state.pipePath && fs.existsSync(state.pipePath)) {
            console.log(`[${channelId}] Təmizləmə: Named pipe faylını (${state.pipePath}) silirəm...`);
            fs.unlinkSync(state.pipePath);
        }
        // WebSocket bağlantısını bağlayırıq
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            console.log(`[${channelId}] Təmizləmə: WebSocket bağlantısını bağlayıram...`);
            state.ws.close();
        }
        // External media kanalını bağlayırıq
        if (state.externalChannel && !state.externalChannel.destroyed) {
            console.log(`[${channelId}] Təmizləmə: External media kanalını bağlayıram...`);
            try { await state.externalChannel.hangup(); } catch (e) { console.log(`[${channelId}] Təmizləmə: External media kanalını bağlayarkən xəta (normaldır): ${e.message}`); }
        }
        // UDP serveri dayandırırıq
        if (state.udpServer) {
            console.log(`[${channelId}] Təmizləmə: UDP serverini bağlayıram...`);
            state.udpServer.close();
        }
        
        callStates.delete(channelId);
        console.log(`[${channelId}] Resurslar uğurla təmizləndi.`);
    } else {
        console.log(`[${channelId}] Təmizləmə: Bu kanal üçün heç bir resurs tapılmadı (artıq təmizlənib).`);
    }
}

// Əsas ARI məntiqi
async function main() {
    try {
        setupSounds();
        setupRecordings();

        const client = await ariClient.connect(ASTERISK_URL, ASTERISK_USERNAME, ASTERISK_PASSWORD);
        console.log(`[${new Date().toISOString()}]`,'✅ ARI-yə uğurla qoşuldu.');

        client.on('StasisStart', async (event, channel) => {
            // Daxili yaradılmış virtual kanalların (Local/ və UnicastRTP/) bütün prosesi yenidən başlatmasının qarşısını alırıq.
            if (channel.name.startsWith('Local/') || channel.name.startsWith('UnicastRTP/')) {
                console.log(`[${new Date().toISOString()}]`,`[${channel.id}] 📞 Virtual kanal (${channel.name}) ignorer edildi.`);
                return;
            }
            
            const channelId = channel.id;
            console.log(`[${new Date().toISOString()}]`,`📞 Yeni zəng qəbul edildi: ${channelId}, Ad: ${channel.name}, Nömrə: ${channel.caller.number}`);
            
            const udpPort = nextUdpPort++;
            console.log(`[${channelId}] Resurslar hazırlanır: UDP Port=${udpPort}, WebSocket URL=${WEBSOCKET_URL}`);
            const ws = new WebSocket(WEBSOCKET_URL);
            const udpServer = dgram.createSocket('udp4');
            
            // Zəngin bütün vəziyyətini bir yerdə saxlayırıq (səs parçalarını toplamaq üçün boş array ilə)
            callStates.set(channelId, { 
                channel, 
                ws, 
                udpServer, 
                udpPort, 
                audioChunks: [],           // Gələn ulaw səs parçaları
                outgoingAudioChunks: [],   // WebSocket-ə göndərilən slin16 səs parçaları
                playbackAudioChunks: [],   // Debug: Səsləndiriləcək slin16 səs parçaları
                ulawToSlinProcess: null,
                // Yeni continuous playback üçün
                continuousPlayback: null,  // Davamlı səsləndirmə obyekti
                continuousSoxProcess: null, // Davamlı sox prosesi
                continuousPipePath: null,  // Named pipe yolu
                audioBuffer: [],           // Gələn audio parçalarını buffer-də saxlayırıq
                isStreamActive: false      // Stream aktiv olub-olmadığı
            });
            console.log(`[${channelId}] Vəziyyət (state) yaradıldı və callStates-ə əlavə edildi.`);

            try {
                console.log(`[${channelId}] Zəngə cavab verməyə çalışıram...`);
                await channel.answer();
                console.log(`[${channelId}] 📢 Zəngə uğurla cavab verildi.`);
                
                udpServer.on('message', (msg) => {
                    const state = callStates.get(channelId);
                    if (!state || !state.ws) {
                        console.warn(`[${channelId}] UDP mesajı gəldi, amma WebSocket mövcud deyil. İgnorer edilir.`);
                        return;
                    }

                    // RTP başlığını kəsirik (12 bayt)
                    const audioChunk = msg.slice(12);
                    
                    // Səs parçasını daha sonra saxlamaq üçün toplayırıq (ulaw formatında)
                    state.audioChunks.push(audioChunk);

                    // ulaw səsi sox prosesinə göndəririk konversiya üçün
                    if (state.ulawToSlinProcess && !state.ulawToSlinProcess.killed) {
                        state.ulawToSlinProcess.stdin.write(audioChunk);
                        console.log(`[${channelId}] [UDP->SOX] ${audioChunk.length} bayt ulaw səs sox prosesinə yazıldı`);
                    } else {
                        console.warn(`[${channelId}] UDP mesajı gəldi, amma ulaw->slin16 konversiya prosesi aktiv deyil.`);
                    }
                });

                udpServer.on('error', (err) => {
                    console.error(`[${channelId}] UDP Server xətası (port ${udpPort}):\n${err.stack}`);
                    udpServer.close();
                });

                console.log(`[${channelId}] UDP serverini ${udpPort} portuna bağlamağa çalışıram...`);
                await new Promise(resolve => udpServer.bind(udpPort, '127.0.0.1', resolve));
                console.log(`[${channelId}] 🎧 UDP server ${udpPort} portunda səsləri uğurla dinləyir.`);

                ws.on('open', async () => {
                    console.log(`[${channelId}] ✅ WebSocket-a uğurla qoşuldu.`);
                    const state = callStates.get(channelId);
                    if (!state) {
                        console.warn(`[${channelId}] WebSocket açıldı, amma zəng vəziyyəti artıq mövcud deyil. Bağlantı bağlanır.`);
                        ws.close();
                        return;
                    }

                    // ulaw-dan slin16-ya konversiya üçün sox prosesi yaradırıq
                    console.log(`[${channelId}] ulaw->slin16 konversiya prosesi başladılır...`);
                    const ulawToSlinProcess = spawn('sox', [
                        '-t', 'ul', '-r', '8000', '-c', '1', '-',  // INPUT: ulaw 8kHz
                        '-t', 'raw', '-r', '16000', '-e', 'signed-integer', '-b', '16', '-L', '-c', '1', '-'  // OUTPUT: slin16 16kHz
                    ]);
                    
                    state.ulawToSlinProcess = ulawToSlinProcess;
                    
                    // Konversiya edilmiş səsi WebSocket-ə göndəririk
                    ulawToSlinProcess.stdout.on('data', (convertedData) => {
                        console.log(`[${channelId}] [CONVERSION] Sox-dan ${convertedData.length} bayt konversiya edilmiş data alındı`);
                        
                        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                            // Konversiya edilmiş səsi də toplayırıq
                            state.outgoingAudioChunks.push(convertedData);
                            console.log(`[${channelId}] [OUTGOING] Konversiya edilmiş səs toplandı. Cari parça sayı: ${state.outgoingAudioChunks.length}`);
                            
                            const arrayBuffer = convertedData.buffer.slice(
                                convertedData.byteOffset,
                                convertedData.byteOffset + convertedData.byteLength
                            );
                            state.ws.send(arrayBuffer);
                            console.log(`[${channelId}] ➡️  ${arrayBuffer.byteLength} bayt konversiya edilmiş səs (slin16) backend-ə göndərildi.`);
                        } else {
                            console.warn(`[${channelId}] [CONVERSION] Konversiya edilmiş data var, amma WebSocket hazır deyil`);
                        }
                    });
                    
                    ulawToSlinProcess.stderr.on('data', (data) => {
                        console.error(`[${channelId}] ulaw->slin16 sox XƏTA: ${data}`);
                    });
                    
                    ulawToSlinProcess.on('exit', (code) => {
                        console.log(`[${channelId}] ulaw->slin16 sox prosesi dayandı. Çıxış kodu: ${code}`);
                    });

                    console.log(`[${channelId}] Səs axını üçün external media kanalı yaradılır...`);
                    const externalChannel = client.Channel();
                    state.externalChannel = externalChannel;

                    // VACIB: Asterisk-dən ulaw formatında səs istəyirik
                    // Çünki SIPStation ulaw/alaw istifadə edir və Asterisk slin16-ya konversiya edə bilmir
                    const requestedFormat = 'ulaw'; // 'slin16' əvəzinə 'ulaw' istəyirik
                    console.log(`[${channelId}] Asterisk-dən səs axınını '${requestedFormat}' formatında istəyirəm...`);

                    await externalChannel.externalMedia({
                        app: ARI_APP_NAME,
                        external_host: `127.0.0.1:${udpPort}`,
                        format: requestedFormat
                    });
                    console.log(`[${channelId}] ✅ External media kanalı uğurla yaradıldı.`);
                    
                    console.log(`[${channelId}] Zəngi və external media kanalını körpüləmək üçün bridge yaradılır...`);
                    const bridge = client.Bridge();
                    await bridge.create({ type: 'mixing' });
                    console.log(`[${channelId}] ✅ Bridge uğurla yaradıldı.`);

                    console.log(`[${channelId}] Kanallar bridge-ə əlavə edilir...`);
                    await bridge.addChannel({ channel: [channelId, externalChannel.id] });
                    console.log(`[${channelId}] ✅ Zəng və external media kanalı körpüləndi. Səs axını başladı.`);
                });

                ws.on('message', async (data) => {
                    console.log(`[${channelId}] 📩 WebSocket-dan yeni mesaj qəbul edildi.`);
                    const state = callStates.get(channelId);
                    if (!state) {
                        console.warn(`[${channelId}] WebSocket mesajı gəldi, lakin zəng vəziyyəti mövcud deyil. İgnorer edilir.`);
                        return; // Zəng bitibsə mesajı ignorer edirik
                    }

                    try {
                        const message = JSON.parse(data);
                        console.log(`[${channelId}] Mesaj emal edilir, Tipi: ${message.type}`);
                        
                        // Mesajın tipini yoxlayırıq (index.tsx-ə uyğun olaraq)
                        if (message.type === 'gemini') {
                            const geminiMessage = message.data;
                            console.log(`[${channelId}] [GEMINI] Mesaj qəbul edildi:`);

                            if (geminiMessage.serverContent?.interrupted) {
                                console.log(`[${channelId}] [GEMINI] 🛑 Servisdən 'interrupted' siqnalı gəldi. Səs axını dayandırılır.`);
                                
                                // Continuous stream-i dayandırırıq
                                if (state.continuousSoxProcess && !state.continuousSoxProcess.killed) {
                                    state.continuousSoxProcess.stdin.end();
                                    state.continuousSoxProcess.kill();
                                }
                                
                                // Playback-i dayandırırıq
                                if (state.continuousPlayback) {
                                    try {
                                        await state.continuousPlayback.stop();
                                    } catch (e) {
                                        console.log(`[${channelId}] [GEMINI] Playback dayandırarkən xəta: ${e.message}`);
                                    }
                                }
                                
                                // Pipe faylını silirik
                                if (state.continuousPipePath && fs.existsSync(state.continuousPipePath)) {
                                    fs.unlinkSync(state.continuousPipePath);
                                }
                                
                                state.isStreamActive = false;
                                state.continuousSoxProcess = null;
                                state.continuousPlayback = null;
                                state.continuousPipePath = null;
                                
                                return;
                            }
    
                            const audioDataBase64 = geminiMessage.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                            const isComplete = geminiMessage.serverContent?.generationComplete === true;

                            if (audioDataBase64) {
                                console.log(`[${channelId}] [GEMINI] Mesajda ${audioDataBase64.length} simvol uzunluğunda base64 səs datası tapıldı.`);
                                const audioBuffer = Buffer.from(audioDataBase64, 'base64');
                                
                                // Continuous stream yanaşması
                                if (!state.isStreamActive) {
                                    console.log(`[${channelId}] [STREAM] 🎶 Davamlı səs axını başladılır...`);
                                    
                                    const useUlaw = true;
                                    const fileExtension = useUlaw ? 'ulaw' : 'sln16';
                                    const pipePath = path.join(SOUNDS_DIR, `stream_${channelId}.${fileExtension}`);
                                    
                                    // Köhnə pipe varsa silirik
                                    if (fs.existsSync(pipePath)) {
                                        fs.unlinkSync(pipePath);
                                    }
                                    
                                    // Named pipe yaradırıq
                                    console.log(`[${channelId}] [STREAM] Named pipe yaradılır: ${pipePath}`);
                                    execSync(`mkfifo ${pipePath}`);
                                    
                                    // Sox prosesini başladırıq (24kHz -> 8kHz ulaw)
                                    const soxArgs = useUlaw ? [
                                        '-t', 'raw', '-r', '24000', '-e', 'signed-integer', '-b', '16', '-L', '-c', '1', '-',
                                        '-t', 'ul', '-r', '8000', '-c', '1', pipePath
                                    ] : [
                                        '-t', 'raw', '-r', '24000', '-e', 'signed-integer', '-b', '16', '-L', '-c', '1', '-',
                                        '-t', 'raw', '-r', '16000', '-e', 'signed-integer', '-b', '16', '-L', '-c', '1', pipePath
                                    ];
                                    
                                    const soxProcess = spawn('sox', soxArgs);
                                    
                                    soxProcess.stderr.on('data', (data) => {
                                        const error = data.toString();
                                        if (!error.includes('WARN')) { // Warning-ləri ignore edirik
                                            console.error(`[${channelId}] [STREAM] sox XƏTA: ${error}`);
                                        }
                                    });
                                    
                                    soxProcess.on('exit', (code) => {
                                        console.log(`[${channelId}] [STREAM] sox prosesi dayandı. Çıxış kodu: ${code}`);
                                        state.isStreamActive = false;
                                    });
                                    
                                    state.continuousSoxProcess = soxProcess;
                                    state.continuousPipePath = pipePath;
                                    state.isStreamActive = true;
                                    
                                    // Başlanğıc səssizlik əlavə edirik (smooth başlanğıc üçün)
                                    const silenceMs = 200; // 200ms səssizlik
                                    const silenceBuffer = Buffer.alloc(silenceMs * 24000 * 2 / 1000, 0); // 24kHz * 2 bytes * 200ms / 1000
                                    soxProcess.stdin.write(silenceBuffer);
                                    
                                    // Asterisk playback-i başladırıq
                                    const playback = client.Playback();
                                    state.continuousPlayback = playback;
                                    
                                    // Playback bitdikdə
                                    playback.once('PlaybackFinished', () => {
                                        console.log(`[${channelId}] [STREAM] Davamlı səsləndirmə tamamlandı.`);
                                        state.isStreamActive = false;
                                        
                                        // Sox prosesini dayandırırıq
                                        if (state.continuousSoxProcess && !state.continuousSoxProcess.killed) {
                                            state.continuousSoxProcess.kill();
                                        }
                                        
                                        // Pipe-ı silirik
                                        if (fs.existsSync(state.continuousPipePath)) {
                                            fs.unlinkSync(state.continuousPipePath);
                                        }
                                        
                                        state.continuousSoxProcess = null;
                                        state.continuousPipePath = null;
                                        state.continuousPlayback = null;
                                    });
                                    
                                    // Kiçik gecikmədən sonra playback başladırıq
                                    setTimeout(async () => {
                                        try {
                                            const soundFile = path.basename(pipePath, `.${fileExtension}`);
                                            await channel.play({ 
                                                media: `sound:${soundFile}`, 
                                                playbackId: playback.id 
                                            });
                                            console.log(`[${channelId}] [STREAM] ✅ Davamlı səsləndirmə başladıldı.`);
                                        } catch (err) {
                                            console.error(`[${channelId}] [STREAM] Playback başladarkən xəta:`, err);
                                            state.isStreamActive = false;
                                        }
                                    }, 50);
                                }
                                
                                // Audio datasını sox prosesinə yazırıq
                                if (state.continuousSoxProcess && !state.continuousSoxProcess.killed) {
                                    // Birbaşa audio datasını yazırıq (overlap əlavə etmirik, çünki bu kəsilməyə səbəb olur)
                                    state.continuousSoxProcess.stdin.write(audioBuffer);
                                    
                                    console.log(`[${channelId}] [STREAM] ⬇️ ${audioBuffer.length} bayt səs datası sox-a yazıldı.`);
                                } else {
                                    console.warn(`[${channelId}] [STREAM] Audio data gəldi amma sox prosesi aktiv deyil.`);
                                }
                            }

                            // Səs axını bitibsə
                            if (isComplete) {
                                console.log(`[${channelId}] [GEMINI] ✅ Servisdən 'generationComplete' siqnalı gəldi.`);
                                
                                if (state.continuousSoxProcess && !state.continuousSoxProcess.killed) {
                                    // Son bir səssizlik əlavə edib stdin-i bağlayırıq
                                    const endSilenceBuffer = Buffer.alloc(100 * 24000 * 2 / 1000, 0); // 100ms səssizlik
                                    state.continuousSoxProcess.stdin.write(endSilenceBuffer);
                                    state.continuousSoxProcess.stdin.end();
                                    
                                    console.log(`[${channelId}] [STREAM] Audio stream tamamlandı, sox stdin bağlandı.`);
                                }
                            }
                            
                        } else if (message.type === 'status') {
                            console.log(`[${channelId}] Servisdən status mesajı:`, message.data);
                        } else if (message.type === 'error') {
                            console.error(`[${channelId}] Servisdən xəta mesajı:`, message.data);
                        }

                    } catch (e) {
                        console.error(`[${channelId}] WebSocket-dan gələn mesajı emal edərkən xəta:`, e.message);
                    }
                });

                ws.on('close', async () => {
                    console.log(`[${channelId}] WebSocket bağlantısı bağlandı. Zəngin bitirilməsi yoxlanılır...`);
                    const state = callStates.get(channelId);
                    // Əgər vəziyyət artıq yoxdursa və ya təmizləmə prosesi başlayıbsa, heç nə etmə.
                    if (!state || state.isCleaningUp) {
                        console.log(`[${channelId}] WebSocket bağlantısı bağlandı (gözlənilən).`);
                        return;
                    }

                    console.log(`[${channelId}] WebSocket bağlantısı GÖZLƏNİLMƏDƏN bağlandı. Zəng bitirilir...`);
                    if (channel && !channel.destroyed) {
                        try { await channel.hangup(); } catch (e) { console.error(`[${channelId}] Zəngi bitirərkən xəta (ws close): ${e.message}`); }
                    }
                });

                ws.on('error', async (err) => {
                    console.log(`[${channelId}] WebSocket xətası:`, err.message);
                    const state = callStates.get(channelId);
                    // Əgər vəziyyət artıq yoxdursa və ya təmizləmə prosesi başlayıbsa, heç nə etmə.
                    if (!state || state.isCleaningUp) {
                        console.error(`[${channelId}] ❌ WebSocket xətası (təmizləmə zamanı):`, err.message);
                        return;
                    }

                    console.error(`[${channelId}] ❌ WebSocket xətası:`, err.message);
                    if (channel && !channel.destroyed) {
                        console.log(`[${channelId}] Xəta səbəbi ilə zəng aktivdir, bitirilir...`);
                        try { await channel.hangup(); } catch (e) { console.error(`[${channelId}] Zəngi bitirərkən xəta (ws error): ${e.message}`); }
                    }
                });

            } catch (err) {
                console.error(`❌ Kanal ${channelId} üçün əsas 'try' blokunda kritik xəta:`, err.message);
                await cleanupCallResources(channelId);
                if (!channel.destroyed) {
                    console.log(`[${channelId}] Kritik xəta sonrası zəng bitirilir...`);
                    try { await channel.hangup(); } catch (e) { console.error(`[${channelId}] Zəngi bitirərkən xəta (main catch): ${e.message}`); }
                }
            }
        });

        client.on('StasisEnd', async (event, channel) => {
            console.log(`📴 Zəng bitirildi (StasisEnd hadisəsi): ${channel.id}`);
            // Təmizləmə prosesinin başladığını qeyd edirik ki, ws.on('close') təkrar əməliyyat etməsin.
            const state = callStates.get(channel.id);
            if (state) {
                state.isCleaningUp = true;
            }
            await cleanupCallResources(channel.id);
        });

        await client.start(ARI_APP_NAME);
        console.log(`👂 '${ARI_APP_NAME}' tətbiqi üçün zənglər gözlənilir...`);

    } catch (err) {
        console.error('❌ ARI-yə qoşularkən kritik xəta baş verdi:', err.message);
        console.error('💡 Yoxlayın: FreePBX-də ARI aktivdirmi? İstifadəçi adı/parol düzgündürmü?');
    }
}

main();