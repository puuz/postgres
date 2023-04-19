const { createHash } = require('node:crypto');
const { Socket } = require('node:net');

const { DriverError } = require('./error');
const { ERROR_CODES, PROTOCOL_VERISON, RESULT_TYPES } = require('./constants');

//https://miro.medium.com/max/1400/1*xnfJ-I1tEE-1PWA0J88whw.jpeg

exports.Driver = class Driver {
    #options;
    #busy = false;
    #connected = false;
    #results = {
        fields: [],
        types: [],
        rows: [],
        status: ''
    }
    #socket = new Socket();
    constructor(options) {
        this.#options = options;
    }
    busy() {
        return this.#busy;
    }
    connected() {
        return this.#connected;
    }
    //error also means to remove the driver
    connect(callback) {
        if (this.#busy || this.#connected) return callback(new DriverError({ message: `The driver is already ${this.#busy ? 'busy' : 'connected'}` }));
        this.#busy = true;
        this.#addErrorListeners(callback);
        this.#socket.on('data', data => this.#handleData(data));
        this.#socket.once('connect', () => {
            const parameters = `user\0${this.#options.username}\0database\0${this.#options.database}\0\0`;
            //8 bytes for two i32s + parameters length for the parameters
            const buffer = Buffer.alloc(8 + parameters.length);
            buffer.writeInt32BE(buffer.length);
            buffer.writeInt32BE(PROTOCOL_VERISON, 4);
            buffer.write(parameters, 8);
            this.#socket.write(buffer);
        });
        this.#socket.once('readyForQuery', () => {
            this.#busy = false;
            this.#connected = true;
            callback();
        });
        this.#socket.connect(this.#options.port, this.#options.host);
    }
    query(query, callback) {
        this.#busy = true;
        //4 bytes for i32 + query length for query + 1 byte for \0
        const length = 4 + query.length + 1;
        //1 byte for Q identifier + length for rest of the length
        const buffer = Buffer.alloc(1 + length);
        buffer.write('Q');
        buffer.writeInt32BE(length, 1);
        buffer.write(query + '\0', 5);
        this.#socket.removeAllListeners('error');
        this.#socket.removeAllListeners('timeout');
        this.#addErrorListeners(callback);
        let readyForResults = false;
        this.#socket.once('readyForResults', () => readyForResults = true);
        this.#socket.once('readyForQuery', () => {
            if (!readyForResults) {
                this.#socket.destroy(new DriverError({ message: `Didn't recieve query results` }));
                return;
            }
            this.#busy = false;
            callback(undefined, undefined, this.#results);
        });
        this.#socket.write(buffer);
    }
    disconnect(callback) {
        this.#busy = true;
        //1 byte for X identifier + 4 bytes for i32
        const buffer = Buffer.alloc(1 + 4);
        buffer.write('X');
        buffer.writeInt32BE(4, 1);
        this.#socket.write(buffer, error => {
            this.#socket.destroy();
            this.#busy = false;
            if (error) return callback(new DriverError({ message: error.message }));
            callback(undefined);
        });
    }
    #addErrorListeners(callback) {
        this.#socket.once('error', error => {
            if (this.#busy) callback(error);
            else callback(undefined, true);
            this.#reset();
        });
        this.#socket.once('timeout', () => {
            this.disconnect(error => {
                if (error) console.error(new DriverError({ message: error.message + `\nFailed to disconnect when socket timed out` }));
                if (this.#busy) callback(new DriverError({ message: `Socket timed out while driver was busy` }));
                else callback(undefined, true);
                this.#reset();
            });
        });
    }
    #reset() {
        this.#socket.removeAllListeners();
        this.#busy = false;
        this.#connected = false;
        this.#results = {
            fields: [],
            types: [],
            rows: [],
            status: ''
        };
    }
    #handleData(data) {
        let identifier = '', offset = 0, length = 0;
        do {
            identifier = String.fromCharCode(data[offset++]);
            //length of the data including these 4 bytes
            length = data.readInt32BE(offset);
            offset += 4;
            //R - Authentication
            //S - ParameterStatus
            //E - ErrorMessage
            //N - NoticeMessage
            //K - BackendKeyData
            //Z - ReadyForQuery
            //T - RowDescription
            //D - DataRow
            //C - CommandComplete
            //https://www.postgresql.org/docs/14/protocol-message-formats.html
            switch (identifier) {
                case 'S': case 'K': break;
                case 'R': this.#password(data, offset); break;
                case 'E': case 'N': this.#error(data, offset, length); break;
                case 'Z': this.#socket.emit('readyForQuery'); break;
                case 'T': this.#fields(data, offset); break;
                case 'D': this.#rows(data, offset); break;
                case 'C': {
                    this.#results.status = data.toString('utf-8', offset, data.indexOf(0, offset));
                    this.#socket.emit('readyForResults', this.#results);
                    break;
                }
                default: this.#socket.destroy(new DriverError({ message: `The identifier (${identifier}) is not supported` })); return;
            }
            //increase the offset by the amount of bytes that were read, but
            //remove 4 since there was 4 added before when essentially read
            offset += length - 4;
        //loop until the offset is equal to the length of the data
        } while (offset < data.length);
    }
    #password(data, offset) {
        let start = offset;
        const authentication = data.readInt32BE(start);
        start += 4;
        //authentication is ok
        if (authentication === 0) return;
        //authentication is md5
        if (authentication === 5) {
            //https://www.postgresql.org/docs/14/protocol-flow.html#id-1.10.5.7.3
            //under the AuthenticationMD5Password description
            const hash = 'md5' + createHash('md5').update(Buffer.concat([
                //authentication hash
                Buffer.from(createHash('md5').update(this.#options.password + this.#options.username).digest('hex')),
                //random salt
                data.slice(start, start + 4)
            ])).digest('hex');
            //4 bytes for i32 + hash length for hash + 1 byte for \0
            const length = 4 + hash.length + 1;
            //1 byte for p identifier + length for rest of the length
            const buffer = Buffer.alloc(1 + length);
            buffer.write('p');
            buffer.writeInt32BE(length, 1);
            buffer.write(hash + '\0', 5);
            this.#socket.write(buffer);
            return;
        }
        this.#socket.destroy(new DriverError({ message: `The authentication (${authentication}) is not ok or md5` }));
    }
    #error(data, offset, length) {
        let start = offset, end, error = {}, code, rawCode;
        //loop until the offset is equal to the length of the data
        while (start < length) {
            rawCode = String.fromCharCode(data[start++]);
            if (rawCode === '0') continue;
            end = data.indexOf(0, start);
            code = ERROR_CODES[rawCode];
            if (code) error[code] =  data.toString('utf-8', start, end);
            start = end + 1;
        }
        //https://www.postgresql.org/docs/14/protocol-error-fields.html
        switch (error.severity) {
            case 'ERROR': case 'FATAL': case 'PANIC':
                this.#socket.destroy(new DriverError(error));
                break;
            case 'WARNING': case 'NOTICE': case 'DEBUG': case 'INFO': case 'LOG':
                console.error(new DriverError(error));
                break;
            default:
                this.#socket.destroy(new DriverError({ message: `The severity (${error.severity}) was neither an error or notice message` }));
                break;
        }
    }
    #fields(data, offset) {
        let start = offset, end;
        const numfOfFields = data.readInt16BE(start);
        start += 2;
        //number of fields can be 0
        if (numfOfFields === 0) return;
        for (let i = 0; i < numfOfFields; i++) {
            end = data.indexOf(0, start);
            this.#results.fields.push(data.toString('utf-8', start, end));
            //end for field name length + 1 byte for \0 since it's a string +
            //4 bytes to skip i32 (oid of table) + 2 bytes to skip i16 (attribute number of column)
            start = end + 1 + 4 + 2;
            //which leaves the offset at the oid for the field's data type
            this.#results.types.push(RESULT_TYPES[data.readInt32BE(start)]);
            //4 bytes for i32 (oid of field's data type) + 2 bytes to skip i16 (data type size) +
            //4 bytes to skip i32 (type modifier) + 2 bytes to skip i16 (format code being used)
            start += 4 + 2 + 4 + 2;
            //which leaves the offset at the next field being the field name
        }
    }
    #rows(data, offset) {
        let start = offset, length, row = {}, columnName, columnValue;
        const numOfColumns = data.readInt16BE(start);
        start += 2;
        //number of columns can be 0
        if (numOfColumns === 0) return;
        for (let i = 0; i < numOfColumns; i++) {
            columnName = this.#results.fields[i];
            length = data.readInt32BE(start);
            start += 4;
            //this indicates the row is null
            if (length === -1) row[columnName] = null;
            else {
                //the column value is based on the length given in the 4 bytes before
                columnValue = data.toString('utf-8', start, start + length);
                //does not support text[][] etc.. or json[][] or json arrays instead of objects
                switch (this.#results.types[i]) {
                    case undefined:
                        this.#socket.destroy(new DriverError({ message: `The result type of index ${i} is undefined` }));
                        return;
                    case 'VARCHAR': case 'TEXT': break;
                    case 'INTEGER':
                        columnValue = Number(columnValue);
                        break;
                    case 'VARCHAR_ARRAY': case 'TEXT_ARRAY':
                        columnValue = (columnValue).slice(1, -1).split(',');
                        break;
                    case 'JSON_ARRAY':
                        columnValue = (columnValue).slice(1, -1).split(',').map(rawJson => {
                            const [k, v] = rawJson.slice(4, -4).split('\\":\\"');
                            return { [k]: v };
                        });
                        break;
                    case 'BOOL':
                        switch (columnValue) {
                            case 't': columnValue = true; break;
                            case 'f': columnValue = false; break;
                            case null: columnValue = null; break;
                            default:
                                this.#socket.destroy(new DriverError({ message: `The bool value (${columnValue}) is not supported` }));
                                return;
                        }
                        break;
                    default:
                        this.#socket.destroy(new DriverError({ message: `The result type of index ${i} (${this.#results.types[i]}) is not supported` }));
                        return;
                }
                row[columnName] = columnValue;
                //position the offset to read in the next column value length by skipping the length of the column value
                start += length;
            }
        }
        this.#results.rows.push(row); 
    }
}