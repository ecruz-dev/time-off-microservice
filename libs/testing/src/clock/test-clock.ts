export interface Clock {
  now(): Date;
}

export class TestClock implements Clock {
  private currentTime: Date;

  constructor(initialTime: Date = new Date('2026-04-08T15:00:00.000Z')) {
    this.currentTime = new Date(initialTime);
  }

  now(): Date {
    return new Date(this.currentTime);
  }

  set(time: Date): this {
    this.currentTime = new Date(time);

    return this;
  }

  advanceByMilliseconds(milliseconds: number): this {
    this.currentTime = new Date(this.currentTime.getTime() + milliseconds);

    return this;
  }

  advanceBySeconds(seconds: number): this {
    return this.advanceByMilliseconds(seconds * 1000);
  }

  advanceByMinutes(minutes: number): this {
    return this.advanceByMilliseconds(minutes * 60 * 1000);
  }

  advanceByDays(days: number): this {
    return this.advanceByMilliseconds(days * 24 * 60 * 60 * 1000);
  }
}
