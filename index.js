const { Driver } = require('./driver');
const { OPTIONS } = require('./constants');
const driver = new Driver(OPTIONS);
const query = `SELECT * FROM test`;
driver.connect((error, removeDriver) => {
    if (error) return console.error(error);
    if (removeDriver) return console.error('Driver lost connection');
    driver.query(query, (error, removeDriver, results) => {
        if (error) return console.error(error);
        if (removeDriver) return console.error('Driver lost connection');
        console.log(results);
        console.log(results.rows);
        driver.disconnect(error => {
            if (error) return console.error(error);
            console.log('disconnected!');
        });
    });
});