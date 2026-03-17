const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// 配置
const CONFIG = {
  // 平台列表API地址
  platformsApiUrl: "http://api.hclyz.com:81/mf/json.txt",
  // 主播信息基础URL
  streamersBaseUrl: "http://api.hclyz.com:81/mf/",
  timeout: 15000,
  concurrentLimit: 3,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
    "Cache-Control": "no-cache"
  }
};

// 请求封装：返回JSON数据
function fetchWithTimeout(url, timeout = CONFIG.timeout) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: CONFIG.headers, timeout }, (res) => {
      let data = [];

      // 重定向处理
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return resolve(fetchWithTimeout(redirectUrl, timeout));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(data);
        try {
          // 尝试解析JSON
          const jsonData = JSON.parse(buffer.toString('utf8'));
          resolve(jsonData);
        } catch (e) {
          reject(new Error(`JSON解析失败: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

// 获取平台列表
async function getPlatforms() {
  console.log('正在获取平台列表...');
  let platformsData;
  
  try {
    platformsData = await fetchWithTimeout(CONFIG.platformsApiUrl);
  } catch (e) {
    throw new Error(`获取平台列表失败: ${e.message}`);
  }

  // 验证返回数据格式
  if (!platformsData || !Array.isArray(platformsData.pingtai)) {
    throw new Error('平台列表数据格式不正确');
  }

  const platforms = [];
  // 提取address和title，构建完整的主播列表URL
  for (const item of platformsData.pingtai) {
    if (item.address && item.title) {
      const platformUrl = new URL(item.address, CONFIG.streamersBaseUrl).href;
      platforms.push({
        name: item.title.trim(),
        url: platformUrl,
        originalAddress: item.address
      });
    }
  }

  console.log(`找到平台：${platforms.length} 个`);
  return platforms;
}

// 获取主播源
async function getStreamers(platform) {
  try {
    console.log(`正在获取 ${platform.name} 的主播信息...`);
    const streamersData = await fetchWithTimeout(platform.url);
    
    // 验证返回数据格式
    if (!streamersData || !Array.isArray(streamersData.zhubo)) {
      console.warn(`⚠️ ${platform.name}：无主播数据或数据格式错误`);
      return { platform, streamers: [] };
    }

    const streamers = [];
    // 提取主播的address和title
    for (const item of streamersData.zhubo) {
      if (item.address && item.title) {
        const title = item.title.trim() || '未知主播';
        const address = item.address.trim();
        
        if (address && address !== 'undefined') {
          streamers.push({ title, address });
        }
      }
    }

    console.log(`✅ ${platform.name}：${streamers.length} 个主播`);
    return { platform, streamers };
  } catch (e) {
    console.error(`❌ ${platform.name} 获取失败：${e.message}`);
    return { platform, streamers: [] };
  }
}

// 并发控制
async function processBatch(items, batchSize, processor) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(item => processor(item).catch(err => ({ platform: item, streamers: [] })))
    );
    results.push(...batchResults);
    // 批次间延迟，避免请求过快
    await new Promise(r => setTimeout(r, 800));
  }
  return results;
}

// 生成 M3U 文件：根据主播标题去重
async function generateM3U() {
  try {
    // 1. 获取所有平台
    const platforms = await getPlatforms();
    
    // 2. 并发获取所有主播信息
    const results = await processBatch(platforms, CONFIG.concurrentLimit, getStreamers);

    // 3. 处理数据，去重并生成M3U内容
    const existedTitles = new Set();
    let m3uContent = "#EXTM3U\n";
    let valid = 0, dup = 0;

    for (const { platform, streamers } of results) {
      for (const s of streamers) {
        // 清理标题，移除特殊字符
        const cleanTitle = s.title.replace(/[,|\n\r]/g, '').trim();
        const addr = s.address.trim();
        
        if (!addr) continue;

        // 检查是否重复
        if (existedTitles.has(cleanTitle)) {
          dup++;
          continue;
        }

        // 添加到M3U内容
        existedTitles.add(cleanTitle);
        m3uContent += `#EXTINF:-1 tvg-id="${cleanTitle}" tvg-name="${cleanTitle}" group-title="${platform.name}",${cleanTitle}\n${addr}\n`;
        valid++;
      }
    }

    // 4. 保存文件
    fs.writeFileSync('live.m3u', m3uContent, 'utf8');

    // 5. 输出统计信息
    console.log('\n======== 生成完成 ========');
    console.log(`有效直播源：${valid} 个`);
    console.log(`重复直播源（同名）：${dup} 个`);
    console.log(`文件已保存为：live.m3u`);

  } catch (e) {
    console.error('程序执行失败：', e.message);
    process.exit(1);
  }
}

// 执行主函数
generateM3U();
