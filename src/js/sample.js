// Lista de demonstração com vídeos públicos de teste.
// Os episódios das séries têm ~10s, ótimos para testar o próximo episódio automático.
const V = 'https://test-videos.co.uk/vids';
const P = (seed) => `https://picsum.photos/seed/${seed}/400/600`;
const W = (seed) => `https://picsum.photos/seed/${seed}/640/360`;

export const SAMPLE_M3U = `#EXTM3U
#EXTINF:-1 tvg-logo="${P('coelho')}" group-title="Séries Demo",Aventuras do Coelho S01E01 - O Despertar
${V}/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4
#EXTINF:-1 tvg-logo="${W('ep2')}" group-title="Séries Demo",Aventuras do Coelho S01E02 - A Floresta
${V}/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4
#EXTINF:-1 tvg-logo="${W('ep3')}" group-title="Séries Demo",Aventuras do Coelho S01E03 - O Plano
${V}/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4
#EXTINF:-1 tvg-logo="${W('ep4')}" group-title="Séries Demo",Aventuras do Coelho S02E01 - Retorno
${V}/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_2MB.mp4
#EXTINF:-1 tvg-logo="${W('ep5')}" group-title="Séries Demo",Aventuras do Coelho S02E02 - Final
${V}/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4
#EXTINF:-1 tvg-logo="${P('sintel')}" group-title="Séries Demo",Sintel S01E01 - A Busca
${V}/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4
#EXTINF:-1 tvg-logo="${W('sintel2')}" group-title="Séries Demo",Sintel S01E02 - O Dragão
${V}/sintel/mp4/h264/720/Sintel_720_10s_1MB.mp4
#EXTINF:-1 tvg-logo="${W('sintel3')}" group-title="Séries Demo",Sintel S01E03 - A Montanha
${V}/sintel/mp4/h264/1080/Sintel_1080_10s_1MB.mp4
#EXTINF:-1 tvg-logo="${P('oceano')}" group-title="Documentários",Mundo Marinho T01E01 - Águas-vivas
${V}/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4
#EXTINF:-1 tvg-logo="${W('oceano2')}" group-title="Documentários",Mundo Marinho T01E02 - Profundezas
${V}/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4
#EXTINF:-1 tvg-logo="${P('tears')}" group-title="Filmes Demo",Tears of Steel (2012)
https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8
#EXTINF:-1 tvg-logo="${P('bunnyhls')}" group-title="Filmes Demo",Big Buck Bunny (2008)
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 tvg-logo="${P('bipbop')}" group-title="Filmes Demo",Apple BipBop (HLS fMP4)
https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8
#EXTINF:-1 tvg-logo="${P('flor')}" group-title="Filmes Demo",Flor (curta)
https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4
#EXTINF:-1 tvg-logo="" group-title="Canais de Teste",Unified Streaming Live
https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8
#EXTINF:-1 tvg-logo="" group-title="Canais de Teste",Canal Teste 8
https://moctobpltc-i.akamaihd.net/hls/live/571329/eight/playlist.m3u8
`;
