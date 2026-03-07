export class CandleBuilder {
  constructor(timeframeMinutes = 3) {
    this.currentCandle = null;
    this.timeframeMs = timeframeMinutes * 60 * 1000; 
  }

  build(price, timestamp) {
    const bucket = Math.floor(timestamp / this.timeframeMs);

    if (!this.currentCandle) {
      this.currentCandle = this._createNewCandle(price, timestamp, bucket);
      return null;
    }

    if (bucket === this.currentCandle.bucket) {
      this.currentCandle.high = Math.max(this.currentCandle.high, price);
      this.currentCandle.low = Math.min(this.currentCandle.low, price);
      this.currentCandle.close = price;
      return null;
    }

    const finishedCandle = { ...this.currentCandle };
    finishedCandle.color = finishedCandle.close >= finishedCandle.open ? 'green' : 'red';
    finishedCandle.range = finishedCandle.high - finishedCandle.low;

    this.currentCandle = this._createNewCandle(price, timestamp, bucket);

    return finishedCandle;
  }

  flush() {
    if (!this.currentCandle) return null;
    
    const finishedCandle = { ...this.currentCandle };
    finishedCandle.color = finishedCandle.close >= finishedCandle.open ? 'green' : 'red';
    finishedCandle.range = finishedCandle.high - finishedCandle.low;
    
    this.currentCandle = null; 
    return finishedCandle;
  }

  _createNewCandle(price, timestamp, bucket) {
    return {
      bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      startTime: timestamp,
    };
  }
}