class ApiResponse {
    constructor(statusCode, data, message){
        this.data = data
        // keep original property for backward compatibility
        this.statuscode = statusCode
        // standard properties
        this.status = statusCode
        this.statusCode = statusCode
        this.message = message
        // success for HTTP is status < 400
        this.success = statusCode < 400
    }
}
export {ApiResponse}