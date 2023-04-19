exports.DriverError = class DriverError extends Error {
    date;
    code;
    severity;
    constructor(options) {
        super(options.message || 'Empty string for driver error message');
        this.name = 'DriverError';
        this.date = new Date().toLocaleString('en-us', { timeZone: 'America/Chicago' });
        if (options.code) this.code = options.code;
        if (options.severity) this.severity = options.severity;
    }
}