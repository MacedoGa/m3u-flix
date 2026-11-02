# M3U Flix

Player de listas **M3U/M3U8** com interface estilo Netflix, focado primeiro em **Windows** (Electron) e
preparado para Smart TV e Android (a interface é web pura, sem framework).

## Recursos

- **Listas M3U por URL ou arquivo**, várias listas salvas, atualização e cópia em cache (abre mesmo offline).
- **Organização automática**: Séries (detecta `S01E02`, `T01E02`, `1x02`, "Temporada 1 Episódio 2"),
  Filmes e TV ao vivo, agrupados por `group-title`.
- **Interface estilo Netflix**: destaque (hero), linhas horizontais, "Continuar assistindo", "Minha lista",
  busca, modal de detalhes com temporadas/episódios.
- **Player completo**: HLS (`hls.js`), MPEG-TS (`mpegts.js`) e MP4/WebM nativo, com troca automática de
  motor quando um falha; baixa latência configurável nos canais ao vivo (desativada por padrão); retoma
  de onde parou; velocidade; tela cheia; atalhos de teclado.
- **Próximo episódio automático**: cartão "Próximo episódio" com contagem regressiva nos créditos,
  passa de temporada sozinho, e pergunta "Você ainda está assistindo?" após N episódios seguidos.
- **Pular abertura**: botão padrão (configurável) e **marcações por série** (início/fim da abertura e início
  dos créditos) feitas no próprio player — valem para todos os episódios; opção de pular automaticamente.
- **Downloads** (app Windows): MP4/MKV diretos e **HLS** (incl. AES-128), fila com 2 downloads paralelos,
  progresso/velocidade, baixar temporada inteira, conversão `.ts → .mp4` com ffmpeg, e reprodução offline
  (o player usa o arquivo local automaticamente quando o item já foi baixado).
- **Navegação por setas** (teclado / controle remoto) pensando em TV.
- Suporte a `#EXTVLCOPT:http-user-agent` / `http-referrer` e User-Agent global nas configurações.

## Como rodar (Windows)

Requer [Node.js LTS](https://nodejs.org/).

```bash
npm install
```

```bash
npm start
```

Gerar instalador (`dist/`):

```bash
npm run dist
```

Na primeira execução use **"Lista de exemplo"** para testar com vídeos públicos (episódios de ~10s, ideais
para ver o próximo episódio automático).

## Atalhos do player

| Tecla | Ação |
| --- | --- |
| Espaço / K | Reproduzir / pausar |
| ← / → | Voltar / avançar 10s |
| ↑ / ↓ | Volume |
| F | Tela cheia |
| M | Mudo |
| N / P | Próximo / anterior (episódio ou canal) |
| S | Pular abertura |
| E | Lista de episódios / canais |
| Esc | Voltar |

`F12` abre o DevTools.

## Estrutura

```
electron/
  main.js        janela, protocolo app://, CORS para streams IPTV, IPC
  preload.js     API segura exposta ao renderer (window.api)
  downloads.js   gerenciador de downloads (direto + HLS, ffmpeg)
src/
  index.html     interface
  css/styles.css tema estilo Netflix
  js/app.js      telas, detalhes, configurações, downloads
  js/player.js   player (hls.js / mpegts.js / nativo), próximo episódio, pular abertura
  js/m3u.js      parser M3U
  js/library.js  classificação séries / filmes / ao vivo
  js/spatial.js  navegação por setas (TV)
  js/store.js    persistência (arquivos JSON no Electron, localStorage na web)
```

## Próximas plataformas

A pasta `src/` roda em qualquer navegador moderno (sem downloads, que dependem do Electron). Os motores
são carregados de `src/vendor/` → `node_modules/` → CDN, nessa ordem; para TV/Android copie
`hls.min.js` e `mpegts.js` para `src/vendor/`.

- **Android / Android TV**: empacotar `src/` com Capacitor e implementar `window.api` (armazenamento e
  downloads) com plugins nativos.
- **Samsung (Tizen) / LG (webOS)**: empacotar `src/` como app web da TV; a navegação por setas e as teclas
  do controle (`MediaPlayPause`, `ChannelUp/Down`, voltar) já são tratadas.

## Limitações conhecidas

- O player embutido usa os codecs do Chromium: H.264/AAC, VP9, AV1, Opus funcionam; **MKV com áudio
  AC3/DTS** ou alguns HEVC podem não tocar. Uma evolução possível é integrar libmpv/libVLC.
- Transmissões ao vivo não podem ser baixadas; HLS com SAMPLE-AES/DRM não é suportado.
