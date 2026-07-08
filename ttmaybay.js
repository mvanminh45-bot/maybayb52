const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const HISTORY_API = 'https://maybayb52-9d2a.onrender.com/api/history';

let historyData = [];
let predictionHistory = [];
let lastPhien = 0;
let currentPrediction = null;
let analysisCache = null;

async function fetchHistoryData() {
  try {
    const response = await axios.get(HISTORY_API, { timeout: 10000 });
    const data = response.data;
    
    if (Array.isArray(data) && data.length > 0) {
      historyData = data.map(item => ({
        phien: item.Phien,
        multiplier: parseFloat(item.Ket_qua),
        timestamp: item.Thoigian
      })).reverse();
      
      return true;
    }
    return false;
  } catch (error) {
    console.error('Lỗi khi lấy dữ liệu:', error.message);
    return false;
  }
}

function calculateEMA(data, period) {
  if (data.length < period) return data[data.length - 1] || 2;
  
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(data, period = 14) {
  if (data.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = data.length - period; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateStdDev(data) {
  if (data.length < 2) return 0;
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const squaredDiffs = data.map(x => Math.pow(x - mean, 2));
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / data.length);
}

function calculateZScore(value, data) {
  if (data.length < 2) return 0;
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const stdDev = calculateStdDev(data);
  if (stdDev === 0) return 0;
  return (value - mean) / stdDev;
}

function calculateBollingerBands(data, period = 20, multiplier = 2) {
  if (data.length < period) {
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    return { upper: mean * 1.5, middle: mean, lower: mean * 0.5 };
  }
  
  const recentData = data.slice(-period);
  const sma = recentData.reduce((a, b) => a + b, 0) / period;
  const stdDev = calculateStdDev(recentData);
  
  return {
    upper: sma + (multiplier * stdDev),
    middle: sma,
    lower: sma - (multiplier * stdDev)
  };
}

function detectStreakPatterns(multipliers) {
  const patterns = {
    consecutiveLow: 0,
    consecutiveVeryLow: 0,
    consecutiveHigh: 0,
    consecutiveMedium: 0,
    phienSinceHigh: 0,
    phienSinceMedium: 0,
    phienSinceVeryHigh: 0
  };
  
  for (let i = multipliers.length - 1; i >= 0; i--) {
    if (multipliers[i] < 2.0) patterns.consecutiveLow++;
    else break;
  }
  
  for (let i = multipliers.length - 1; i >= 0; i--) {
    if (multipliers[i] < 1.5) patterns.consecutiveVeryLow++;
    else break;
  }
  
  for (let i = multipliers.length - 1; i >= 0; i--) {
    if (multipliers[i] >= 3.0) patterns.consecutiveHigh++;
    else break;
  }
  
  for (let i = multipliers.length - 1; i >= 0; i--) {
    if (multipliers[i] >= 2.0 && multipliers[i] < 5.0) patterns.consecutiveMedium++;
    else break;
  }
  
  for (let i = multipliers.length - 1; i >= 0; i--) {
    if (multipliers[i] >= 5) break;
    patterns.phienSinceHigh++;
  }
  
  for (let i = multipliers.length - 1; i >= 0; i--) {
    if (multipliers[i] >= 3) break;
    patterns.phienSinceMedium++;
  }
  
  for (let i = multipliers.length - 1; i >= 0; i--) {
    if (multipliers[i] >= 10) break;
    patterns.phienSinceVeryHigh++;
  }
  
  return patterns;
}

function detectTrapPatterns(multipliers) {
  const traps = {
    postHighTrap: false,
    grindTrap: false,
    teaseTrap: false,
    fakeBreakout: false,
    exhaustionTrap: false,
    trapScore: 0
  };
  
  const last5 = multipliers.slice(-5);
  const last10 = multipliers.slice(-10);
  const last20 = multipliers.slice(-20);
  
  const highIndex = last5.findIndex(m => m >= 5);
  if (highIndex !== -1 && highIndex < last5.length - 1) {
    const afterHighValues = last5.slice(highIndex + 1);
    if (afterHighValues.length > 0) {
      const avgAfterHigh = afterHighValues.reduce((a, b) => a + b, 0) / afterHighValues.length;
      if (avgAfterHigh < 1.8) {
        traps.postHighTrap = true;
        traps.trapScore += 25;
      }
    }
  }
  
  const lowCount20 = last20.filter(m => m < 2.0).length;
  if (lowCount20 >= 15) {
    traps.grindTrap = true;
    traps.trapScore += 20;
  }
  
  const pattern = last5.map(m => m >= 2.5 ? 'H' : 'L').join('');
  if (pattern === 'LHLHL' || pattern === 'HLHLH') {
    traps.teaseTrap = true;
    traps.trapScore += 30;
  }
  
  const avg10 = last10.reduce((a, b) => a + b, 0) / last10.length;
  const hasSpike = last5.some(m => m > avg10 * 2);
  const afterSpike = last5.slice(-2).every(m => m < avg10);
  if (hasSpike && afterSpike) {
    traps.fakeBreakout = true;
    traps.trapScore += 35;
  }
  
  let trendUp = 0;
  for (let i = 1; i < last10.length; i++) {
    if (last10[i] > last10[i - 1]) trendUp++;
  }
  if (trendUp >= 7 && last10[last10.length - 1] >= 3) {
    traps.exhaustionTrap = true;
    traps.trapScore += 25;
  }
  
  return traps;
}

function detectCyclePosition(multipliers) {
  const last50 = multipliers.slice(-50);
  const avg50 = last50.reduce((a, b) => a + b, 0) / last50.length;
  
  const highPeaks = [];
  for (let i = 1; i < last50.length - 1; i++) {
    if (last50[i] >= 5 && last50[i] > last50[i - 1] && last50[i] > last50[i + 1]) {
      highPeaks.push(i);
    }
  }
  
  let avgCycleLength = 15;
  if (highPeaks.length >= 2) {
    const cycleLengths = [];
    for (let i = 1; i < highPeaks.length; i++) {
      cycleLengths.push(highPeaks[i] - highPeaks[i - 1]);
    }
    avgCycleLength = cycleLengths.reduce((a, b) => a + b, 0) / cycleLengths.length;
  }
  
  const lastPeakIndex = highPeaks.length > 0 ? highPeaks[highPeaks.length - 1] : 0;
  const positionInCycle = last50.length - 1 - lastPeakIndex;
  const cycleProgress = Math.min(1, positionInCycle / avgCycleLength);
  
  return {
    avgCycleLength: Math.round(avgCycleLength),
    positionInCycle,
    cycleProgress,
    expectedPeakSoon: cycleProgress > 0.7,
    avgValue: avg50,
    peakCount: highPeaks.length
  };
}

function analyzeVolatility(multipliers) {
  const last10 = multipliers.slice(-10);
  const last20 = multipliers.slice(-20);
  const last50 = multipliers.slice(-50);
  
  const volatility10 = calculateStdDev(last10);
  const volatility20 = calculateStdDev(last20);
  const volatility50 = calculateStdDev(last50);
  
  let regime = 'normal';
  if (volatility10 > volatility50 * 1.5) {
    regime = 'high_volatility';
  } else if (volatility10 < volatility50 * 0.5) {
    regime = 'low_volatility';
  }
  
  const isIncreasing = volatility10 > volatility20;
  
  return {
    short: volatility10,
    medium: volatility20,
    long: volatility50,
    regime,
    isIncreasing,
    ratio: volatility10 / Math.max(0.1, volatility50)
  };
}

function calculateMeanReversion(multipliers) {
  const last20 = multipliers.slice(-20);
  const last50 = multipliers.slice(-50);
  const last100 = multipliers.slice(-100);
  
  const mean20 = last20.reduce((a, b) => a + b, 0) / last20.length;
  const mean50 = last50.reduce((a, b) => a + b, 0) / last50.length;
  const mean100 = last100.length > 0 ? last100.reduce((a, b) => a + b, 0) / last100.length : mean50;
  
  const lastValue = multipliers[multipliers.length - 1];
  const deviation20 = (lastValue - mean20) / mean20;
  const deviation50 = (lastValue - mean50) / mean50;
  
  let reversionPressure = 0;
  if (deviation20 < -0.3) reversionPressure = Math.min(100, Math.abs(deviation20) * 100);
  else if (deviation20 > 0.5) reversionPressure = -Math.min(50, deviation20 * 30);
  
  return {
    mean20,
    mean50,
    mean100,
    deviation20,
    deviation50,
    reversionPressure,
    shouldRevert: Math.abs(deviation20) > 0.25
  };
}

function detectBookmakerIntent(multipliers, traps, cycle, volatility, meanReversion) {
  const intent = {
    phase: 'neutral',
    confidence: 50,
    expectedAction: 'normal',
    riskLevel: 'medium',
    signals: []
  };
  
  if (traps.grindTrap && cycle.cycleProgress > 0.6) {
    intent.phase = 'accumulation';
    intent.expectedAction = 'preparing_breakout';
    intent.confidence = 70;
    intent.signals.push('Nhà cái đang tích lũy, chuẩn bị nổ');
  }
  
  if (traps.postHighTrap || traps.fakeBreakout) {
    intent.phase = 'distribution';
    intent.expectedAction = 'trapping_players';
    intent.confidence = 75;
    intent.riskLevel = 'high';
    intent.signals.push('Nhà cái đang phân phối, bẫy người chơi');
  }
  
  if (volatility.regime === 'low_volatility' && cycle.positionInCycle > cycle.avgCycleLength * 0.8) {
    intent.phase = 'pre_explosion';
    intent.expectedAction = 'major_move_incoming';
    intent.confidence = 65;
    intent.signals.push('Biến động thấp bất thường, sắp có chuyển động lớn');
  }
  
  if (meanReversion.reversionPressure > 60) {
    intent.phase = 'reversion';
    intent.expectedAction = 'mean_reversion';
    intent.confidence = 60;
    intent.signals.push('Áp lực hồi về trung bình cao');
  }
  
  if (traps.teaseTrap) {
    intent.phase = 'manipulation';
    intent.expectedAction = 'confusing_players';
    intent.confidence = 70;
    intent.riskLevel = 'high';
    intent.signals.push('Nhà cái đang thao túng, tạo nhiễu');
  }
  
  if (traps.exhaustionTrap) {
    intent.phase = 'exhaustion';
    intent.expectedAction = 'trend_reversal';
    intent.confidence = 65;
    intent.signals.push('Xu hướng tăng kiệt sức, sắp đảo chiều');
  }
  
  return intent;
}

function calculateConfidenceScore(analysis) {
  let score = 50;
  
  if (analysis.rsi < 25) score += 15;
  else if (analysis.rsi > 75) score -= 10;
  
  if (analysis.volatility.regime === 'low_volatility') score += 10;
  else if (analysis.volatility.regime === 'high_volatility') score -= 15;
  
  const trapScore = isNaN(analysis.traps.trapScore) ? 0 : Math.min(100, Math.max(0, analysis.traps.trapScore));
  score -= trapScore * 0.3;
  
  if (analysis.cycle.expectedPeakSoon) score += 10;
  
  if (analysis.meanReversion.shouldRevert && analysis.meanReversion.deviation20 < -0.2) {
    score += 15;
  }
  
  const signalAlignment = analysis.intent.signals.length;
  if (signalAlignment >= 2) score += 10;
  
  if (analysis.ema5 < analysis.ema10 && analysis.ema10 < analysis.ema20) {
    score += 5;
  }
  
  return Math.max(10, Math.min(95, Math.round(score)));
}

function generateSmartPrediction(analysis, streaks, multipliers) {
  let prediction;
  let type = 'safe';
  let reasoning = [];
  
  if (analysis.intent.phase === 'accumulation' && analysis.cycle.expectedPeakSoon) {
    if (streaks.consecutiveVeryLow >= 4 || (streaks.consecutiveLow >= 5 && analysis.rsi < 20)) {
      prediction = 7.0 + Math.random() * 5.0;
      type = 'no_lon';
      reasoning.push('Chuỗi thấp kéo dài + RSI cực thấp + Chu kỳ sắp đến đỉnh');
    } else if (streaks.consecutiveVeryLow >= 3 || streaks.consecutiveLow >= 4) {
      prediction = 5.0 + Math.random() * 4.0;
      type = 'no_lon';
      reasoning.push('Tích lũy gần hoàn tất + Áp lực nổ cao');
    } else {
      prediction = 3.5 + Math.random() * 2.5;
      type = 'no_vua';
      reasoning.push('Đang trong giai đoạn tích lũy');
    }
  }
  else if (analysis.intent.phase === 'pre_explosion') {
    if (analysis.volatility.ratio < 0.5 && streaks.phienSinceHigh >= 10) {
      prediction = 6.0 + Math.random() * 5.0;
      type = 'no_lon';
      reasoning.push('Biến động cực thấp + Lâu chưa nổ = Sắp nổ lớn');
    } else {
      prediction = 4.0 + Math.random() * 3.0;
      type = 'no_lon';
      reasoning.push('Biến động thấp bất thường, chuẩn bị chuyển động');
    }
  }
  else if (analysis.intent.phase === 'distribution' || analysis.intent.phase === 'exhaustion') {
    const lastMultiplier = multipliers[multipliers.length - 1];
    if (lastMultiplier >= 5) {
      prediction = 1.10 + Math.random() * 0.15;
      type = 'safe';
      reasoning.push('Vừa nổ lớn + Nhà cái đang phân phối = Cực kỳ thấp');
    } else if (lastMultiplier >= 3) {
      prediction = 1.20 + Math.random() * 0.15;
      type = 'safe';
      reasoning.push('Sau nổ vừa + Giai đoạn phân phối');
    } else {
      prediction = 1.35 + Math.random() * 0.15;
      type = 'safe';
      reasoning.push('Giai đoạn phân phối/kiệt sức');
    }
  }
  else if (analysis.intent.phase === 'manipulation') {
    prediction = 1.50 + Math.random() * 0.30;
    type = 'safe';
    reasoning.push('Nhà cái đang thao túng = Chơi an toàn');
  }
  else if (analysis.intent.phase === 'reversion') {
    if (analysis.meanReversion.deviation20 < -0.4) {
      prediction = 4.0 + Math.random() * 3.0;
      type = 'no_lon';
      reasoning.push('Độ lệch cực cao + Áp lực hồi về mạnh');
    } else if (analysis.meanReversion.deviation20 < -0.25) {
      prediction = 2.5 + Math.random() * 2.0;
      type = 'no_vua';
      reasoning.push('Đang hồi về trung bình');
    } else {
      prediction = 1.80 + Math.random() * 0.40;
      type = 'safe';
      reasoning.push('Hồi về trung bình nhẹ');
    }
  }
  else {
    if (streaks.consecutiveVeryLow >= 3) {
      prediction = 5.0 + Math.random() * 4.0;
      type = 'no_lon';
      reasoning.push('Chuỗi rất thấp kéo dài');
    } else if (streaks.consecutiveLow >= 4) {
      prediction = 4.0 + Math.random() * 3.0;
      type = 'no_lon';
      reasoning.push('Chuỗi thấp kéo dài');
    } else if (streaks.phienSinceHigh >= 8 && analysis.rsi < 35) {
      prediction = 4.5 + Math.random() * 3.5;
      type = 'no_lon';
      reasoning.push('Lâu chưa nổ + RSI thấp');
    } else if (streaks.phienSinceMedium >= 5 && analysis.rsi < 40) {
      prediction = 3.0 + Math.random() * 2.0;
      type = 'no_vua';
      reasoning.push('Lâu chưa có nổ vừa + RSI thấp vừa');
    } else if (analysis.rsi < 30 && analysis.meanReversion.deviation20 < -0.2) {
      prediction = 2.5 + Math.random() * 1.5;
      type = 'no_vua';
      reasoning.push('RSI thấp + Dưới trung bình');
    } else if (streaks.consecutiveHigh >= 2) {
      prediction = 1.15 + Math.random() * 0.10;
      type = 'safe';
      reasoning.push('Chuỗi cao liên tiếp = Sắp điều chỉnh');
    } else if (analysis.rsi > 70) {
      prediction = 1.25 + Math.random() * 0.15;
      type = 'safe';
      reasoning.push('RSI quá cao = Quá mua');
    } else {
      const last = multipliers[multipliers.length - 1];
      if (last >= 5) {
        prediction = 1.15 + Math.random() * 0.15;
        type = 'safe';
        reasoning.push('Sau nổ lớn = Giảm mạnh');
      } else if (last >= 3) {
        prediction = 1.30 + Math.random() * 0.20;
        type = 'safe';
        reasoning.push('Sau nổ vừa = Điều chỉnh');
      } else {
        prediction = 1.40 + Math.random() * 0.20;
        type = 'safe';
        reasoning.push('Trạng thái bình thường');
      }
    }
  }
  
  if (analysis.traps.trapScore > 50) {
    prediction = Math.max(1.10, prediction * 0.7);
    if (type !== 'safe') {
      type = 'safe';
      reasoning.push('⚠️ Điều chỉnh do phát hiện bẫy nhà cái');
    }
  }
  
  return {
    value: Math.round(prediction * 100) / 100,
    type,
    reasoning
  };
}

function predictNextMultiplier(history) {
  if (history.length < 5) {
    return { 
      value: 1.50, 
      type: 'safe',
      confidence: 30,
      analysis: null,
      reasoning: ['Đang khởi động...']
    };
  }
  
  const multipliers = history.map(h => h.multiplier);
  
  const ema5 = calculateEMA(multipliers, 5);
  const ema10 = calculateEMA(multipliers, 10);
  const ema20 = calculateEMA(multipliers, 20);
  
  const rsi = calculateRSI(multipliers, 14);
  
  const bollinger = calculateBollingerBands(multipliers, 20);
  
  const lastValue = multipliers[multipliers.length - 1];
  const zScore = calculateZScore(lastValue, multipliers.slice(-50));
  
  const streaks = detectStreakPatterns(multipliers);
  
  const traps = detectTrapPatterns(multipliers);
  
  const cycle = detectCyclePosition(multipliers);
  
  const volatility = analyzeVolatility(multipliers);
  
  const meanReversion = calculateMeanReversion(multipliers);
  
  const analysis = {
    ema5, ema10, ema20,
    rsi,
    bollinger,
    zScore,
    traps,
    cycle,
    volatility,
    meanReversion
  };
  
  const intent = detectBookmakerIntent(multipliers, traps, cycle, volatility, meanReversion);
  analysis.intent = intent;
  
  const prediction = generateSmartPrediction(analysis, streaks, multipliers);
  
  const confidence = calculateConfidenceScore(analysis);
  
  analysisCache = {
    ...analysis,
    streaks,
    lastMultiplier: lastValue,
    timestamp: new Date().toISOString()
  };
  
  return {
    value: prediction.value,
    type: prediction.type,
    confidence,
    reasoning: prediction.reasoning,
    analysis: {
      rsi: Math.round(rsi),
      ema: { ema5: ema5.toFixed(2), ema10: ema10.toFixed(2), ema20: ema20.toFixed(2) },
      volatility: volatility.regime,
      cycle: { position: cycle.positionInCycle, avgLength: cycle.avgCycleLength },
      trapScore: traps.trapScore,
      intent: intent.phase,
      signals: intent.signals.slice(0, 3)
    }
  };
}

function checkPredictionAccuracy(predictedValue, actualValue) {
  return actualValue >= predictedValue;
}

async function updatePredictions() {
  const success = await fetchHistoryData();
  
  if (!success || historyData.length === 0) {
    console.log('Không thể lấy dữ liệu từ API');
    return;
  }
  
  const latestPhien = historyData[historyData.length - 1].phien;
  
  if (lastPhien !== 0 && latestPhien > lastPhien && currentPrediction) {
    const actualResult = historyData[historyData.length - 1].multiplier;
    const isCorrect = checkPredictionAccuracy(currentPrediction.value, actualResult);
    
    predictionHistory.push({
      phien: currentPrediction.phien,
      du_doan: currentPrediction.value,
      type: currentPrediction.type,
      confidence: currentPrediction.confidence,
      thuc_te: actualResult,
      ket_qua: isCorrect ? '✅' : '❌',
      is_correct: isCorrect,
      reasoning: currentPrediction.reasoning,
      timestamp: new Date().toISOString()
    });
    
    if (predictionHistory.length > 100) {
      predictionHistory.shift();
    }
    
    const recent = predictionHistory.slice(-20);
    const accuracy = (recent.filter(p => p.is_correct).length / recent.length * 100).toFixed(0);
    
    const typeIcon = currentPrediction.type === 'no_lon' ? '🔥' : 
                     currentPrediction.type === 'no_vua' ? '⚡' : '✅';
    
    const confIcon = currentPrediction.confidence >= 70 ? '🎯' : 
                     currentPrediction.confidence >= 50 ? '📊' : '⚠️';
    
    console.log(`[${new Date().toLocaleTimeString()}] #${latestPhien} | Thực: ${actualResult.toFixed(2)}x | Dự: ${currentPrediction.value}x ${typeIcon} | Tin cậy: ${currentPrediction.confidence}% ${confIcon} | ${isCorrect ? '✅' : '❌'} | Win: ${accuracy}%`);
    if (currentPrediction.reasoning && currentPrediction.reasoning.length > 0) {
      console.log(`   └─ ${currentPrediction.reasoning.join(' | ')}`);
    }
  }
  
  lastPhien = latestPhien;
  
  const nextPhien = latestPhien + 1;
  const prediction = predictNextMultiplier(historyData);
  
  currentPrediction = {
    phien: nextPhien,
    value: prediction.value,
    type: prediction.type,
    confidence: prediction.confidence,
    reasoning: prediction.reasoning,
    analysis: prediction.analysis,
    timestamp: new Date().toISOString()
  };
}

async function initialize() {
  console.log('='.repeat(60));
  console.log('🚀 AVIATOR PREDICTION - THUẬT TOÁN THÔNG MINH v3.0');
  console.log('='.repeat(60));
  console.log('📊 Phân tích kỹ thuật: EMA, RSI, Bollinger Bands, Z-Score');
  console.log('🔍 Phát hiện bẫy nhà cái: Trap Detection System');
  console.log('📈 Phân tích chu kỳ: Cycle Analysis');
  console.log('🎯 Độ tin cậy: Confidence Scoring');
  console.log('='.repeat(60));
  console.log('✅ An toàn (Safe): 1.0x - 2.0x');
  console.log('⚡ Nổ vừa (Medium): 2.0x - 5.0x');
  console.log('🔥 Nổ lớn (High): 5.0x+');
  console.log('='.repeat(60));
  
  await updatePredictions();
  setInterval(updatePredictions, 5000);
  
  console.log('✅ Server đã sẵn sàng với thuật toán thông minh!');
}

initialize();

app.get('/', (req, res) => {
  res.send('@tiendataox');
});

app.get('/maybay', async (req, res) => {
  if (!currentPrediction) {
    await updatePredictions();
  }
  
  if (!currentPrediction) {
    return res.status(503).json({ error: 'Đang tải dữ liệu...' });
  }
  
  res.json({
    phien: currentPrediction.phien.toString(),
    du_doan: currentPrediction.value.toFixed(2),
    confidence: currentPrediction.confidence,
    type: currentPrediction.type,
    reasoning: currentPrediction.reasoning,
    analysis: currentPrediction.analysis,
    id: '@tiendataox'
  });
});

app.get('/maybay/lichsu', (req, res) => {
  const completedPredictions = predictionHistory.slice(-30).reverse();
  
  const correctCount = completedPredictions.filter(p => p.is_correct).length;
  const totalCount = completedPredictions.length;
  const accuracy = totalCount > 0 ? ((correctCount / totalCount) * 100).toFixed(1) : 0;
  
  const byType = {
    safe: { total: 0, correct: 0 },
    no_vua: { total: 0, correct: 0 },
    no_lon: { total: 0, correct: 0 }
  };
  
  completedPredictions.forEach(p => {
    if (byType[p.type]) {
      byType[p.type].total++;
      if (p.is_correct) byType[p.type].correct++;
    }
  });
  
  const formattedHistory = completedPredictions.map(p => ({
    phien: p.phien.toString(),
    du_doan: p.du_doan.toFixed(2),
    thuc_te: p.thuc_te.toFixed(2),
    type: p.type,
    confidence: p.confidence,
    ket_qua: p.ket_qua,
    reasoning: p.reasoning ? p.reasoning[0] : ''
  }));
  
  res.json({
    thong_ke: {
      tong_du_doan: totalCount,
      dung: correctCount,
      sai: totalCount - correctCount,
      ti_le_chinh_xac: `${accuracy}%`,
      theo_loai: {
        safe: `${byType.safe.correct}/${byType.safe.total}`,
        no_vua: `${byType.no_vua.correct}/${byType.no_vua.total}`,
        no_lon: `${byType.no_lon.correct}/${byType.no_lon.total}`
      }
    },
    lich_su: formattedHistory,
    id: 'tiendataox'
  });
});

app.get('/maybay/analysis', (req, res) => {
  if (!analysisCache) {
    return res.status(503).json({ error: 'Chưa có dữ liệu phân tích' });
  }
  
  res.json({
    chi_so_ky_thuat: {
      rsi: analysisCache.rsi.toFixed(1),
      ema: {
        ema5: analysisCache.ema5.toFixed(2),
        ema10: analysisCache.ema10.toFixed(2),
        ema20: analysisCache.ema20.toFixed(2)
      },
      bollinger: {
        upper: analysisCache.bollinger.upper.toFixed(2),
        middle: analysisCache.bollinger.middle.toFixed(2),
        lower: analysisCache.bollinger.lower.toFixed(2)
      },
      z_score: analysisCache.zScore.toFixed(2)
    },
    bay_nha_cai: {
      diem_bay: analysisCache.traps.trapScore,
      cac_bay: {
        bay_sau_no: analysisCache.traps.postHighTrap,
        bay_mai: analysisCache.traps.grindTrap,
        bay_treo: analysisCache.traps.teaseTrap,
        fake_breakout: analysisCache.traps.fakeBreakout,
        kiet_suc: analysisCache.traps.exhaustionTrap
      }
    },
    chu_ky: {
      do_dai_tb: analysisCache.cycle.avgCycleLength,
      vi_tri_hien_tai: analysisCache.cycle.positionInCycle,
      tien_do: `${(analysisCache.cycle.cycleProgress * 100).toFixed(0)}%`,
      sap_den_dinh: analysisCache.cycle.expectedPeakSoon
    },
    bien_dong: {
      che_do: analysisCache.volatility.regime,
      ngan_han: analysisCache.volatility.short.toFixed(2),
      trung_han: analysisCache.volatility.medium.toFixed(2),
      dai_han: analysisCache.volatility.long.toFixed(2)
    },
    hoi_ve_tb: {
      mean_20: analysisCache.meanReversion.mean20.toFixed(2),
      mean_50: analysisCache.meanReversion.mean50.toFixed(2),
      do_lech: `${(analysisCache.meanReversion.deviation20 * 100).toFixed(1)}%`,
      ap_luc: analysisCache.meanReversion.reversionPressure.toFixed(0)
    },
    y_dinh_nha_cai: {
      giai_doan: analysisCache.intent.phase,
      hanh_dong_du_kien: analysisCache.intent.expectedAction,
      do_tin_cay: analysisCache.intent.confidence,
      muc_rui_ro: analysisCache.intent.riskLevel,
      tin_hieu: analysisCache.intent.signals
    },
    streaks: analysisCache.streaks,
    cap_nhat: analysisCache.timestamp,
    id: '@tiendataox'
  });
});

app.get('/maybay/raw', async (req, res) => {
  await fetchHistoryData();
  const limit = parseInt(req.query.limit) || 50;
  
  res.json({
    history: historyData.slice(-limit).reverse(),
    total: historyData.length,
    source: HISTORY_API
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server chạy tại port ${PORT}`);
});