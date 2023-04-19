//currently have a max of 100 total connections, so once
//there's more than 10 shards this setting should be changed
module.exports = {
    MAX_CONNECTIONS: 10,

    OPTIONS: {
        database: 'postgres',
        username: 'postgres',
        password: 'postgres',
        host: 'localhost',
        port: 5432
    },
    
    //https://www.postgresql.org/docs/14/protocol-message-formats.html
    PROTOCOL_VERISON: 196608,
    
    //https://www.postgresql.org/docs/14/protocol-error-fields.html
    ERROR_CODES: {
        C: 'code',
        M: 'message',
        S: 'severity'
    },
    
    //https://github.com/brianc/node-pg-types/blob/master/lib/builtins.js are built oids, so for
    //the non built in, run a query that involves the needed type and debug the object identifier,
    //which is in the field private function
    RESULT_TYPES: {
        16: 'BOOL',
        23: 'INTEGER', //4 bytes
        25: 'TEXT',
        199: 'JSON_ARRAY',
        1009: 'TEXT_ARRAY',
        1015: 'VARCHAR_ARRAY',
        1043: 'VARCHAR'
    }
}